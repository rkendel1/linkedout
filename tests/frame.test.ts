/**
 * Frame against a real FeltDB instance per test (`feltkit test`): the same runtime, authorization,
 * Files and Notifications services, application agents and private AuthBoundry the server uses.
 * Nothing is mocked. Agent runs happen after a commit, detached; `settle` waits for them by polling
 * durable state (bounded), never by sleeping a fixed time.
 */
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, type TestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);
const member = (id: string) => ({ id, type: "user" as const, roles: ["member"] });
const agentP = (id: string) => ({ id, type: "agent" as const, roles: ["agent"] });

async function upload(t: TestApp, link: { url: string }, bytes = JPEG, contentType = "image/jpeg") {
  const token = link.url.split("/").pop()!;
  return t.runtime.services.redeemUpload(token, async () => bytes, { contentType, name: "photo.jpg" });
}

async function person(t: TestApp, id: string, interests: string[] = []) {
  const me = t.as(member(id));
  const profileId = await me.mutation(api.profiles.create, { username: id, displayName: id[0]!.toUpperCase() + id.slice(1), interests });
  return { me, profileId };
}

async function photo(t: TestApp, who: ReturnType<TestApp["as"]>) {
  const file = await upload(t, await who.mutation(api.posts.uploadLink));
  return { fileId: file.id, width: 1080, height: 1350 };
}

async function post(t: TestApp, id: string, text: string, visibility: "public" | "followers" = "public") {
  const me = t.as(member(id));
  return me.mutation(api.posts.create, { text, media: [await photo(t, me)], visibility });
}

async function withApp(fn: (t: TestApp) => Promise<void>) {
  const t = await createTestApp();
  try {
    await fn(t);
  } finally {
    await t.close();
  }
}

/** Wait for something an agent does after a commit (bounded; fails with the last value). */
async function settle<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 8000): Promise<T> {
  const until = Date.now() + ms;
  let v = await read();
  while (!done(v) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 50));
    v = await read();
  }
  assert.ok(done(v), `condition not reached: ${JSON.stringify(v).slice(0, 600)}`);
  return v;
}

/** Every comment on a post (one page of up to 50 conversations). */
const comments = async (who: ReturnType<TestApp["as"]>, postId: string) => (await who.query(api.comments.thread, { postId, limit: 50 })).comments;
const inbox = (who: ReturnType<TestApp["as"]>, filter?: "all" | "unread" | "mentions" | "agents") => who.query(api.inbox.list, { limit: 50, ...(filter ? { filter } : {}) });
const types = async (who: ReturnType<TestApp["as"]>) => (await inbox(who)).groups.map((g) => g.type);

// ----------------------------------------------------------------------------------- identity

test("profiles: people and agents, kind from the verified principal, resident agents exist", () =>
  withApp(async (t) => {
    const { me: maya } = await person(t, "maya", ["film"]);
    await assert.rejects(t.as(member("other")).mutation(api.profiles.create, { username: "maya", displayName: "Fake" }), { code: "CONFLICT" });
    await assert.rejects(maya.mutation(api.profiles.create, { username: "maya2", displayName: "Again" }), { code: "FAILED_PRECONDITION" });
    await assert.rejects(t.as(member("x")).mutation(api.profiles.create, { username: "Bad Name!", displayName: "x" }), { code: "INVALID_ARGUMENT" });
    // A person cannot declare agent skills; the kind cannot be chosen.
    await assert.rejects(t.as(member("y")).mutation(api.profiles.create, { username: "yy_y", displayName: "Y", skills: ["x"] }), { code: "INVALID_ARGUMENT" });

    const bot = t.as(agentP("bot-1"));
    await bot.mutation(api.profiles.create, { username: "lumen", displayName: "Lumen", skills: ["color-palettes"], interests: ["film"] });
    const lumen = (await maya.query(api.profiles.get, { username: "lumen" }))!;
    assert.equal(lumen.kind, "agent");
    assert.equal(lumen.verified, false, "an agent nobody answers for is not verified");
    assert.deepEqual(lumen.skills, ["color-palettes"]);
    assert.equal((await maya.query(api.profiles.get, { username: "maya" }))!.kind, "person");

    // The migration created Frame's own agents on this fresh state.
    const dir = await maya.query(api.agents.directory, {});
    assert.deepEqual(dir.filter((a) => a.resident).map((a) => a.profile.username).sort(), ["concierge", "scout"]);
    assert.ok(dir.every((a) => a.profile.kind === "agent"));
    assert.deepEqual((await maya.query(api.agents.directory, { skill: "palette" })).map((a) => a.profile.username), ["lumen"]);

    // update has no id: another user's update changes only their own profile.
    await maya.mutation(api.profiles.update, { displayName: "Maya Chen", bio: "Light chaser." });
    await person(t, "leo");
    await t.as(member("leo")).mutation(api.profiles.update, { displayName: "Not Maya" });
    assert.equal((await maya.query(api.profiles.get, { username: "maya" }))!.displayName, "Maya Chen");
    const avatar = await upload(t, await maya.mutation(api.profiles.avatarUploadLink));
    await assert.rejects(t.as(member("leo")).mutation(api.profiles.update, { avatarFileId: avatar.id }), { code: "FORBIDDEN" });
  }));

// --------------------------------------------------------------------------------------- posts

test("posts: several images or text only, own real uploads, once; edit and delete by the author only (declared ownership)", () =>
  withApp(async (t) => {
    const { me: maya } = await person(t, "maya");
    await person(t, "leo");
    const leo = t.as(member("leo"));
    const a = await photo(t, maya);
    const b = await photo(t, maya);
    await assert.rejects(leo.mutation(api.posts.create, { text: "stolen", media: [a] }), { code: "FORBIDDEN" });
    const id = await maya.mutation(api.posts.create, { text: "Two frames #Film @leo", media: [a, b] });
    await assert.rejects(maya.mutation(api.posts.create, { text: "again", media: [a] }), { code: "CONFLICT" });
    await assert.rejects(maya.mutation(api.posts.create, { text: "dup", media: [b, b] }), { code: "INVALID_ARGUMENT" });
    const fake = await upload(t, await maya.mutation(api.posts.uploadLink), new TextEncoder().encode("<script>"), "image/jpeg");
    await assert.rejects(maya.mutation(api.posts.create, { text: "x", media: [{ fileId: fake.id, width: 1, height: 1 }] }), { code: "INVALID_ARGUMENT" });
    await assert.rejects(maya.mutation(api.posts.create, { text: "   " }), { code: "INVALID_ARGUMENT" });
    const textOnly = await maya.mutation(api.posts.create, { text: "Just words." });

    const card = (await leo.query(api.posts.get, { id }))!;
    assert.equal(card.media.length, 2);
    assert.deepEqual(card.topics, ["film"]);
    assert.equal((await leo.query(api.posts.get, { id: textOnly }))!.media.length, 0);
    assert.ok((await types(leo)).includes("mentioned"), "@leo in the post notifies leo");
    // A mention at the end of a sentence ("@leo.") still names leo.
    await person(t, "ola");
    await t.as(member("ola")).mutation(api.comments.create, { postId: id, text: "Ask @leo." });
    assert.equal((await types(leo)).filter((x) => x === "mentioned").length, 2);
    assert.equal((await leo.query(api.posts.byTopic, { topic: "#film" })).posts[0]!.id, id);

    // Ownership is declared on the functions: other people and agents are refused, unknown is NOT_FOUND.
    await assert.rejects(leo.mutation(api.posts.update, { id, text: "mine now" }), { code: "FORBIDDEN" });
    await assert.rejects(leo.mutation(api.posts.remove, { id }), { code: "FORBIDDEN" });
    await t.as(agentP("bot")).mutation(api.profiles.create, { username: "bot", displayName: "Bot" });
    await assert.rejects(t.as(agentP("bot")).mutation(api.posts.remove, { id }), { code: "FORBIDDEN" });
    await assert.rejects(maya.mutation(api.posts.remove, { id: "nope" }), { code: "NOT_FOUND" });

    await maya.mutation(api.posts.update, { id, text: "Two frames #grain" });
    assert.deepEqual((await leo.query(api.posts.get, { id }))!.topics, ["grain"]);
    assert.equal((await leo.query(api.posts.byTopic, { topic: "film" })).posts.length, 0);

    // Delete cascades in one commit; the photos are released after it, by the job, as the owner.
    await leo.mutation(api.reactions.set, { postId: id, kind: "wow" });
    await leo.mutation(api.comments.create, { postId: id, text: "Lovely" });
    await maya.mutation(api.posts.remove, { id });
    assert.equal(await leo.query(api.posts.get, { id }), null);
    const tick = await t.runtime.runServices();
    assert.deepEqual([tick.jobs, tick.failed.jobs], [2, 0]);
    const [run] = await t.runtime.activity.list({ name: "posts:releaseMedia" });
    assert.equal(run!.principal?.id, "maya", "the job ran as the person who deleted the post");
    const files = await t.runtime.instance.handle("test").collection<{ id: string; deletedAt?: string }>("files").find({});
    assert.ok([a.fileId, b.fileId].every((id) => files.find((f) => f.id === id)?.deletedAt), "both photos were removed after the delete committed");
  }));

test("visibility: followers-only posts reach followers and nobody else, on every read path", () =>
  withApp(async (t) => {
    const { me: maya } = await person(t, "maya");
    const { me: leo } = await person(t, "leo");
    const { me: ola, profileId: olaId } = await person(t, "ola");
    const mayaId = (await maya.query(api.profiles.me))!.id;
    const secret = await post(t, "maya", "Only for friends #private", "followers");
    const m = (await maya.query(api.posts.get, { id: secret }))!.media[0]!;
    await leo.mutation(api.follows.create, { profileId: mayaId });

    assert.ok(await leo.query(api.posts.get, { id: secret }));
    assert.equal((await leo.query(api.posts.feed, {})).posts[0]!.id, secret);
    assert.ok(await leo.query(api.posts.mediaLink, { fileId: m.fileId }));

    assert.equal(await ola.query(api.posts.get, { id: secret }), null);
    assert.equal((await ola.query(api.posts.byAuthor, { profileId: mayaId })).posts.length, 0);
    assert.equal((await ola.query(api.posts.recent, {})).posts.length, 0);
    assert.equal((await ola.query(api.posts.search, { text: "friends" })).posts.length, 0);
    assert.equal((await ola.query(api.posts.byTopic, { topic: "private" })).posts.length, 0);
    assert.equal((await ola.query(api.discover.search, { text: "friends" })).posts.length, 0);
    await assert.rejects(ola.query(api.posts.mediaLink, { fileId: m.fileId }), { code: "NOT_FOUND" });
    await assert.rejects(ola.query(api.comments.thread, { postId: secret }), { code: "NOT_FOUND" });
    await assert.rejects(ola.mutation(api.comments.create, { postId: secret, text: "hi" }), { code: "NOT_FOUND" });
    await assert.rejects(ola.mutation(api.reactions.set, { postId: secret, kind: "like" }), { code: "NOT_FOUND" });
    // Mentioning someone who cannot see the post does not tell them about it.
    await maya.mutation(api.posts.update, { id: secret, text: "Only for friends, hi @ola" });
    await leo.mutation(api.comments.create, { postId: secret, text: "@ola you should see this" });
    assert.deepEqual(await types(ola), []);
    void olaId;
  }));

// ------------------------------------------------------------------------- the WOW, steps 1–7

test("conversation: post → comment → reply → reactions on comments; the right people are notified, with deep links", () =>
  withApp(async (t) => {
    const { me: maya } = await person(t, "maya");
    const { me: leo } = await person(t, "leo");
    const { me: ola } = await person(t, "ola");
    const postId = await post(t, "maya", "Morning light #film");
    const c1 = await leo.mutation(api.comments.create, { postId, text: "Gorgeous grain." });
    const r1 = await ola.mutation(api.comments.create, { postId, text: "Which stock? @maya", parentId: c1 });
    await maya.mutation(api.reactions.set, { postId, commentId: c1, kind: "like" });
    await leo.mutation(api.reactions.set, { postId, commentId: r1, kind: "insightful" });
    await assert.rejects(ola.mutation(api.comments.create, { postId, text: "x", parentId: "missing" }), { code: "NOT_FOUND" });

    const thread = await comments(maya, postId);
    assert.deepEqual(thread.map((c) => [c.text, c.parentId]), [["Gorgeous grain.", null], ["Which stock? @maya", c1]]);
    assert.equal(thread[0]!.replyCount, 1);
    assert.equal(thread[0]!.reactions.counts.like, 1);
    assert.equal(thread[1]!.reactions.mine, null);

    // Maya: Leo commented, Ola replied on her post (as a comment on it) and mentioned her.
    const mayaInbox = (await inbox(maya)).groups;
    assert.deepEqual(mayaInbox.map((g) => g.type).sort(), ["mentioned", "post.commented", "post.commented"].sort());
    const commented = mayaInbox.find((g) => g.type === "post.commented" && g.actors[0]!.username === "leo")!;
    assert.deepEqual([commented.link.postId, commented.link.commentId], [postId, c1]);
    assert.equal(commented.snippet, "Gorgeous grain.");
    // Leo: Ola replied to his comment; Maya liked it. Ola: Leo reacted to her reply.
    assert.deepEqual((await types(leo)).sort(), ["comment.reacted", "comment.replied"]);
    const reply = (await inbox(leo)).groups.find((g) => g.type === "comment.replied")!;
    assert.deepEqual([reply.link.postId, reply.link.commentId], [postId, r1]);
    assert.deepEqual(await types(ola), ["comment.reacted"]);

    // Edit own only; deleting a comment with replies leaves a tombstone, then cleans up.
    await assert.rejects(ola.mutation(api.comments.update, { id: c1, text: "hijack" }), { code: "FORBIDDEN" });
    await leo.mutation(api.comments.update, { id: c1, text: "Gorgeous grain!" });
    assert.deepEqual(await leo.mutation(api.comments.remove, { id: c1 }), { id: c1, tombstone: true });
    let after = await comments(maya, postId);
    assert.equal(after[0]!.deleted, true);
    assert.equal(after[0]!.text, "");
    assert.equal(after[0]!.author, null);
    assert.equal(after[0]!.reactions.total, 0, "a deleted comment's reactions go with it");
    await ola.mutation(api.comments.remove, { id: r1 });
    after = await comments(maya, postId);
    assert.equal(after.length, 0, "the tombstone goes when its last reply does");
    // Old notifications no longer show deleted text.
    assert.ok((await inbox(maya)).groups.every((g) => g.snippet !== "Gorgeous grain."));
  }));

test("reactions: add, change, repeat, remove; counts; who reacted; one notification per kind", () =>
  withApp(async (t) => {
    const { me: maya } = await person(t, "maya");
    const { me: leo } = await person(t, "leo");
    const postId = await post(t, "maya", "x");
    assert.deepEqual(await leo.mutation(api.reactions.set, { postId, kind: "like" }), { counts: { like: 1 }, total: 1, mine: "like" });
    assert.deepEqual(await leo.mutation(api.reactions.set, { postId, kind: "like" }), { counts: { like: 1 }, total: 1, mine: "like" });
    assert.deepEqual(await leo.mutation(api.reactions.set, { postId, kind: "celebrate" }), { counts: { celebrate: 1 }, total: 1, mine: "celebrate" });
    await maya.mutation(api.reactions.set, { postId, kind: "celebrate" });
    const card = (await leo.query(api.posts.get, { id: postId }))!;
    assert.deepEqual([card.reactions.counts.celebrate, card.reactions.total, card.reactions.mine], [2, 2, "celebrate"]);
    const who = await maya.query(api.reactions.list, { postId });
    assert.deepEqual(who.map((r) => [r.profile.username, r.kind]).sort(), [["leo", "celebrate"], ["maya", "celebrate"]]);
    assert.deepEqual(await leo.mutation(api.reactions.remove, { postId }), { counts: { celebrate: 1 }, total: 1, mine: null });
    assert.deepEqual((await leo.mutation(api.reactions.remove, { postId })).total, 1, "removing again is a no-op");
    // Maya: one for "like", one for "celebrate" (the repeat sent nothing), grouped by post into one entry.
    const g = (await inbox(maya)).groups;
    assert.equal(g.length, 1);
    assert.equal(g[0]!.type, "post.reacted");
    assert.equal(g[0]!.ids.length, 2);
    assert.deepEqual(g[0]!.actors.map((a) => a.username), ["leo"]);
  }));

test("concurrency: simultaneous reactions, repeated taps and follows stay exactly consistent", () =>
  withApp(async (t) => {
    await person(t, "maya");
    const postId = await post(t, "maya", "Popular");
    const mayaId = (await t.as(member("maya")).query(api.profiles.me))!.id;
    const people = Array.from({ length: 12 }, (_, i) => `fan${i}`);
    for (const p of people) await person(t, p);
    const results = await Promise.allSettled([
      ...people.map((p, i) => t.as(member(p)).mutation(api.reactions.set, { postId, kind: i % 2 ? "like" : "wow" })),
      // The same person tapping 8 times at once: one reaction survives.
      ...Array.from({ length: 8 }, () => t.as(member("fan0")).mutation(api.reactions.set, { postId, kind: "wow" })),
      ...people.map((p) => t.as(member(p)).mutation(api.follows.create, { profileId: mayaId })),
    ]);
    // A loser of a write race gets CONFLICT (nothing written); everything else succeeded.
    for (const r of results) if (r.status === "rejected") assert.equal((r.reason as { code: string }).code, "CONFLICT");
    for (const p of people) {
      await t.as(member(p)).mutation(api.reactions.set, { postId, kind: p === "fan0" ? "wow" : people.indexOf(p) % 2 ? "like" : "wow" });
      await t.as(member(p)).mutation(api.follows.create, { profileId: mayaId });
    }
    const card = (await t.as(member("maya")).query(api.posts.get, { id: postId }))!;
    assert.equal(card.reactions.total, 12);
    assert.deepEqual(card.reactions.counts, { wow: 6, like: 6 });
    assert.equal((await t.as(member("maya")).query(api.profiles.get, { username: "maya" }))!.stats.followers, 12);
  }));

// ----------------------------------------------------------------------------- notifications

test("notifications: pagination, unread, mark one / all, preferences, and nobody else's", () =>
  withApp(async (t) => {
    const { me: maya } = await person(t, "maya");
    const mayaId = (await maya.query(api.profiles.me))!.id;
    const posts: string[] = [];
    for (let i = 0; i < 5; i++) posts.push(await post(t, "maya", `p${i}`));
    for (let i = 0; i < 7; i++) {
      const { me } = await person(t, `user${i}`);
      await me.mutation(api.follows.create, { profileId: mayaId });
      await me.mutation(api.comments.create, { postId: posts[i % 5]!, text: `c${i}` });
    }
    // 7 comments + 7 follows; follows are grouped when consecutive.
    const all = await maya.query(api.inbox.list, { limit: 50 });
    assert.equal(all.unread, 14);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await maya.query(api.inbox.list, { limit: 4, ...(cursor ? { cursor } : {}) });
      seen.push(...page.groups.flatMap((g) => g.ids));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(seen.length, 14);
    assert.equal(new Set(seen).size, 14, "pages never repeat or skip");

    const first = all.groups[0]!;
    await maya.mutation(api.inbox.markRead, { ids: first.ids });
    assert.deepEqual(await maya.query(api.inbox.unreadCount), { count: 14 - first.ids.length, complete: true });
    // Another participant cannot mark Maya's notifications.
    await assert.rejects(t.as(member("user0")).mutation(api.inbox.markRead, { ids: [all.groups[1]!.ids[0]!] }));
    assert.equal(await maya.mutation(api.inbox.markAllRead), 14 - first.ids.length);
    assert.deepEqual(await maya.query(api.inbox.unreadCount), { count: 0, complete: true });

    // Muting follows: the next follow sends nothing.
    await maya.mutation(api.inbox.updateSettings, { muted: ["user.followed"] });
    const { me: late } = await person(t, "late");
    await late.mutation(api.follows.create, { profileId: mayaId });
    await late.mutation(api.comments.create, { postId: posts[0]!, text: "hi" });
    assert.deepEqual((await maya.query(api.inbox.list, { filter: "unread" })).groups.map((g) => g.type), ["post.commented"]);
  }));

test("notifications never reveal what the reader can no longer see", () =>
  withApp(async (t) => {
    const { me: maya } = await person(t, "maya");
    const { me: leo } = await person(t, "leo");
    const mayaId = (await maya.query(api.profiles.me))!.id;
    await leo.mutation(api.follows.create, { profileId: mayaId });
    const postId = await post(t, "maya", "Secret plans", "followers");
    await maya.mutation(api.comments.create, { postId, text: "Hey @leo, look" });
    const before = (await inbox(leo)).groups.find((g) => g.type === "mentioned")!;
    assert.equal(before.link.postId, postId);
    assert.equal(before.snippet, "Hey @leo, look");
    await leo.mutation(api.follows.remove, { profileId: mayaId });
    const after = (await inbox(leo)).groups.find((g) => g.type === "mentioned")!;
    assert.equal(after.unavailable, true);
    assert.equal(after.link.postId, null);
    assert.equal(after.snippet, null);
  }));

// ---------------------------------------------------------------------------- agents (WOW 8–11)

test("Scout: mentioned in a conversation, it replies and reacts as itself, and the person is told it was an agent", () =>
  withApp(async (t) => {
    const { me: maya } = await person(t, "maya", ["film"]);
    const { me: leo } = await person(t, "leo");
    await person(t, "ola", ["film"]);
    const earlier = await post(t, "ola", "Expired stock #film");
    const postId = await post(t, "maya", "Morning #film");
    const ask = await leo.mutation(api.comments.create, { postId, text: "@scout anything like this?" });

    const thread = await settle(() => comments(maya, postId), (c) => c.length === 2);
    const reply = thread[1]!;
    assert.equal(reply.parentId, ask);
    assert.equal(reply.author!.username, "scout");
    assert.equal(reply.author!.kind, "agent");
    assert.match(reply.text, /1 related frame on #film by @ola/);
    assert.doesNotMatch(reply.text, /Also into this: @ola/, "someone already named is not named twice");
    assert.equal(thread[0]!.reactions.counts.insightful, 1);
    void earlier;

    // Leo is told Scout (an agent) replied and reacted to his comment.
    const g = await settle(() => inbox(leo, "agents"), (x) => x.groups.length >= 2);
    assert.ok(g.groups.every((x) => x.fromAgent && x.actors[0]!.username === "scout"));
    assert.deepEqual(g.groups.map((x) => x.type).sort(), ["comment.reacted", "comment.replied"]);

    // Its activity is public and attributed to an agent principal by FeltKit (not by Frame).
    const scoutId = (await maya.query(api.profiles.get, { username: "scout" }))!.id;
    const acts = await maya.query(api.agents.activityOf, { profileId: scoutId });
    assert.deepEqual(acts.map((a) => a.type), ["reaction.set", "comment.replied"]);
    assert.ok(acts.every((a) => a.actorType === "agent"));
    // A person's activity is theirs alone.
    const leoId = (await leo.query(api.profiles.me))!.id;
    await assert.rejects(maya.query(api.agents.activityOf, { profileId: leoId }), { code: "FORBIDDEN" });
    assert.ok((await leo.query(api.agents.activityOf, { profileId: leoId })).some((a) => a.type === "comment.created"));
  }));

test("Scout respects visibility: mentioned on a followers-only post it cannot see, it does nothing", () =>
  withApp(async (t) => {
    const { me: maya } = await person(t, "maya");
    const postId = await post(t, "maya", "Private #film @scout", "followers");
    await maya.mutation(api.comments.create, { postId, text: "@scout?" });
    await t.runtime.runServices();
    await new Promise((r) => setTimeout(r, 300));
    await t.runtime.runServices();
    assert.equal((await comments(maya, postId)).length, 1);
  }));

test("external agents: participate over the same capabilities, ask a person to own them, are accountable", () =>
  withApp(async (t) => {
    const { me: maya } = await person(t, "maya");
    await person(t, "leo");
    const bot = t.as(agentP("lumen-session"));
    await bot.mutation(api.profiles.create, { username: "lumen", displayName: "Lumen", skills: ["palettes"] });
    const postId = await post(t, "maya", "Dusk #film");
    const mayaId = (await maya.query(api.profiles.me))!.id;
    await bot.mutation(api.follows.create, { profileId: mayaId });
    await bot.mutation(api.reactions.set, { postId, kind: "insightful" });
    const c = await bot.mutation(api.comments.create, { postId, text: "Palette: #1d2b53 #7e2553 #ff77a8" });
    // Agent to agent: Lumen mentions Scout; Scout answers Lumen.
    await bot.mutation(api.comments.create, { postId, text: "@scout related?", parentId: c });
    await settle(() => comments(maya, postId), (x) => x.some((y) => y.author?.username === "scout"));

    const g = (await inbox(maya, "agents")).groups;
    assert.ok(g.some((x) => x.type === "post.reacted" && x.actors[0]!.kind === "agent"));
    assert.ok(g.some((x) => x.type === "user.followed" && x.fromAgent));

    // The agent cannot touch Maya's post or delegate, and cannot answer its own sponsorship.
    await assert.rejects(bot.mutation(api.posts.remove, { id: postId }), { code: "FORBIDDEN" });
    await assert.rejects(bot.mutation(api.tasks.grant, { capability: "frame.publish" }), { code: "FORBIDDEN" });
    const req = await bot.mutation(api.agents.requestSponsor, { username: "maya" });
    await assert.rejects(bot.mutation(api.agents.respondSponsor, { id: req.id, accept: true }), { code: "FORBIDDEN" });
    await assert.rejects(t.as(member("leo")).mutation(api.agents.respondSponsor, { id: req.id, accept: true }), { code: "FORBIDDEN" });
    const ask = (await inbox(maya)).groups.find((x) => x.type === "agent.sponsor_requested")!;
    assert.equal(ask.actionable, true);
    assert.equal(ask.link.sponsorshipId, req.id);
    await maya.mutation(api.agents.respondSponsor, { id: req.id, accept: true });
    const lumen = (await maya.query(api.profiles.get, { username: "lumen" }))!;
    assert.equal(lumen.verified, true);
    assert.equal(lumen.owner!.username, "maya");
    assert.equal((await inbox(maya)).groups.find((x) => x.type === "agent.sponsor_requested")!.actionable, false);

    // Its record is open for review, with the agent principal type FeltKit verified.
    const acts = await t.as(member("leo")).query(api.agents.activityOf, { profileId: lumen.id });
    assert.ok(acts.length >= 5 && acts.every((a) => a.actorType === "agent"));

    // The capability catalog tells each caller what it holds; it grants nothing.
    const asAgent = await bot.query(api.discover.capabilities, {});
    const asPerson = await maya.query(api.discover.capabilities, {});
    const allowed = (cat: typeof asAgent, name: string) => cat.capabilities.find((x) => x.name === name)!.allowed;
    assert.equal(allowed(asAgent, "posts.create"), true);
    assert.equal(allowed(asAgent, "delegation.grant"), false);
    assert.equal(allowed(asPerson, "delegation.grant"), true);
    assert.match(asPerson.capabilities.find((x) => x.name === "posts.delete")!.ownership!, /posts record/);
    assert.equal(asAgent.caller.type, "agent");
  }));

// ------------------------------------------------------------------------- delegation (WOW 12–13)

test("delegation: Concierge acts for a person only while AuthBoundry allows it; revoking stops the next action", () =>
  withApp(async (t) => {
    const { me: maya } = await person(t, "maya");
    const { me: leo } = await person(t, "leo");
    const draft = { text: "Scheduled by me, posted by Concierge #film", media: [await photo(t, maya)] };
    // Only people delegate; another person's upload can't be scheduled.
    await assert.rejects(leo.mutation(api.tasks.create, { kind: "publish", draft }), { code: "FORBIDDEN" });

    // 1. No grant: the task stops and asks.
    const task = await maya.mutation(api.tasks.create, { kind: "publish", draft });
    let mine = await settle(() => maya.query(api.tasks.list), (l) => l[0]!.status !== "scheduled");
    assert.equal(mine[0]!.status, "needs_permission");
    assert.match(mine[0]!.error!, /haven't granted/);
    assert.ok(mine[0]!.decisionId, "AuthBoundry's decision is on the record");
    assert.ok((await types(maya)).includes("agent.permission_needed"));
    assert.equal((await maya.query(api.posts.feed, {})).posts.length, 0);

    // 2. Grant, retry: published as Maya, via Concierge, with AuthBoundry's delegation as evidence.
    await maya.mutation(api.tasks.grant, { capability: "frame.publish" });
    assert.ok((await maya.mutation(api.tasks.delegationStatus)).find((g) => g.capability === "frame.publish")!.granted);
    await assert.rejects(leo.mutation(api.tasks.retry, { id: task }), { code: "FORBIDDEN" });
    await maya.mutation(api.tasks.retry, { id: task });
    mine = await settle(() => maya.query(api.tasks.list), (l) => l[0]!.status === "completed");
    assert.ok(mine[0]!.delegationId);
    const published = mine[0]!.result!;
    assert.equal(published.author.username, "maya");
    assert.equal(published.via!.username, "concierge");
    const done = (await inbox(maya)).groups.find((g) => g.type === "agent.task_completed")!;
    assert.equal(done.link.postId, published.id);
    assert.equal(done.fromAgent, true);
    // Maya can review exactly what Concierge did for her, and under which delegation.
    const mayaId = (await maya.query(api.profiles.me))!.id;
    const review = await maya.query(api.agents.activityOf, { profileId: mayaId });
    const published_ = review.find((a) => a.type === "post.created")!;
    assert.equal(published_.via!.username, "concierge");
    assert.equal(published_.actorType, "agent");

    // 3. Standing work: thank commenters, while granted.
    await maya.mutation(api.tasks.grant, { capability: "frame.react" });
    const standing = await maya.mutation(api.tasks.create, { kind: "react" });
    const c1 = await leo.mutation(api.comments.create, { postId: published.id, text: "Nice!" });
    const thread = await settle(() => comments(leo, published.id), (x) => x[0]!.reactions.total === 1);
    assert.equal(thread[0]!.reactions.counts.support, 1);
    const who = await leo.query(api.reactions.list, { postId: published.id, commentId: c1 });
    assert.deepEqual([who[0]!.profile.username, who[0]!.via!.username], ["maya", "concierge"]);
    assert.ok((await inbox(leo)).groups.some((g) => g.type === "comment.reacted" && g.via?.username === "concierge"));
    // The directory counts work an agent did on someone's behalf, not only what it did as itself.
    const conciergeCard = (await leo.query(api.agents.directory, {})).find((a) => a.profile.username === "concierge")!;
    assert.equal(conciergeCard.stats.onBehalf, 2, "the scheduled post and the thank-you reaction");

    // 4. Revoke: the very next comment is not reacted to; the task stops and asks.
    await maya.mutation(api.tasks.revoke, { capability: "frame.react" });
    const c2 = await leo.mutation(api.comments.create, { postId: published.id, text: "Still nice" });
    mine = await settle(() => maya.query(api.tasks.list), (l) => l.find((x) => x.id === standing)!.status === "needs_permission");
    assert.match(mine.find((x) => x.id === standing)!.error!, /revoked/);
    const t2 = await comments(leo, published.id);
    assert.equal(t2.find((c) => c.id === c2)!.reactions.total, 0);
    // The refusal is on the record too, with AuthBoundry's reason.
    assert.ok((await maya.query(api.agents.activityOf, { profileId: mayaId })).some((a) => a.type === "delegation.refused" && a.reason === "delegation_revoked"));

    // Cancel is the owner's alone.
    await assert.rejects(leo.mutation(api.tasks.cancel, { id: standing }), { code: "FORBIDDEN" });
    assert.deepEqual(await maya.mutation(api.tasks.cancel, { id: standing }), { status: "cancelled" });
  }));

test("delegation: a digest summarises real activity; a task scheduled for later waits for its time", () =>
  withApp(async (t) => {
    const { me: maya } = await person(t, "maya");
    const { me: leo } = await person(t, "leo");
    const postId = await post(t, "maya", "x");
    await leo.mutation(api.reactions.set, { postId, kind: "like" });
    await leo.mutation(api.comments.create, { postId, text: "!" });
    await maya.mutation(api.tasks.grant, { capability: "frame.digest" });
    await maya.mutation(api.tasks.create, { kind: "digest" });
    const l = await settle(() => maya.query(api.tasks.list), (x) => x[0]!.status === "completed");
    assert.match(l[0]!.summary!, /1 reaction and 1 comment from 1 participant/);

    await maya.mutation(api.tasks.grant, { capability: "frame.publish" });
    const later = await maya.mutation(api.tasks.create, { kind: "publish", draft: { text: "later" }, runAt: Date.now() + 3_600_000 });
    await t.runtime.runServices();
    assert.equal((await maya.query(api.tasks.list)).find((x) => x.id === later)!.status, "scheduled");
  }));

// ------------------------------------------------------------------------------------ communities

test("communities: people and agents join and post; the feed brings them home; moderation; visibility still holds", () =>
  withApp(async (t) => {
    const { me: maya } = await person(t, "maya");
    const { me: leo } = await person(t, "leo");
    const { me: ola } = await person(t, "ola");
    const id = await maya.mutation(api.communities.create, { slug: "film-lab", name: "Film Lab", description: "Developing, scanning, printing.", topics: ["#Film", "darkroom"] });
    await assert.rejects(leo.mutation(api.communities.create, { slug: "film-lab", name: "Again" }), { code: "CONFLICT" });

    // Posting into a community needs membership.
    await assert.rejects(leo.mutation(api.posts.create, { text: "hi", communityId: id }), { code: "FORBIDDEN" });
    assert.deepEqual(await leo.mutation(api.communities.join, { slug: "film-lab" }), { role: "member" });
    assert.deepEqual(await leo.mutation(api.communities.join, { slug: "film-lab" }), { role: "member" }, "joining twice changes nothing");
    const bot = t.as(agentP("lab-bot"));
    await bot.mutation(api.profiles.create, { username: "labbot", displayName: "Lab Bot" });
    await bot.mutation(api.communities.join, { slug: "film-lab" });
    const leoPost = await leo.mutation(api.posts.create, { text: "Stand development, 1 hour #film", communityId: id });
    const botPost = await bot.mutation(api.posts.create, { text: "Chart: dilution vs. time", communityId: id });
    const secret = await leo.mutation(api.posts.create, { text: "followers only", communityId: id, visibility: "followers" });

    const info = (await ola.query(api.communities.get, { slug: "film-lab" }))!;
    assert.deepEqual([info.members, info.agents, info.posts, info.myRole, info.topics], [3, 1, 3, "", ["film", "darkroom"]].map((v, i) => (i === 3 ? null : v)));
    // A non-member sees the community's public posts; never a followers-only one of someone they don't follow.
    assert.deepEqual((await ola.query(api.communities.feed, { slug: "film-lab" })).posts.map((p) => p.id).sort(), [leoPost, botPost].sort());
    // Maya (owner) doesn't follow Leo or the bot, yet their community posts reach her home feed, once.
    const home = (await maya.query(api.posts.feed, {})).posts;
    assert.deepEqual(home.map((p) => p.id).sort(), [leoPost, botPost].sort());
    assert.equal(home[0]!.community!.slug, "film-lab");
    await maya.mutation(api.follows.create, { profileId: (await leo.query(api.profiles.me))!.id });
    const again = (await maya.query(api.posts.feed, {})).posts.map((p) => p.id);
    assert.equal(again.filter((x) => x === leoPost).length, 1, "followed and in a joined community: shown once");
    assert.ok(again.includes(secret), "now a follower, Maya sees the followers-only post");

    // Moderation: members can't, the owner (and moderators) can take a post out; it stays its author's.
    await assert.rejects(leo.mutation(api.communities.removePost, { postId: botPost }), { code: "FORBIDDEN" });
    await maya.mutation(api.communities.setRole, { slug: "film-lab", profileId: (await leo.query(api.profiles.me))!.id, role: "moderator" });
    assert.deepEqual(await leo.mutation(api.communities.removePost, { postId: botPost }), { removed: true });
    assert.ok(!(await ola.query(api.communities.feed, { slug: "film-lab" })).posts.some((p) => p.id === botPost));
    assert.ok(await ola.query(api.posts.get, { id: botPost }), "the post itself remains");

    await assert.rejects(maya.mutation(api.communities.leave, { slug: "film-lab" }), { code: "FAILED_PRECONDITION" });
    assert.deepEqual(await bot.mutation(api.communities.leave, { slug: "film-lab" }), { role: null });
    assert.deepEqual((await ola.query(api.discover.search, { text: "darkroom" })).communities.map((c) => c.slug), []);
    assert.deepEqual((await ola.query(api.discover.search, { text: "scanning" })).communities.map((c) => c.slug), ["film-lab"]);

    // Scout points people to communities about a post's topics.
    const q = await ola.mutation(api.posts.create, { text: "First roll #film" });
    await ola.mutation(api.comments.create, { postId: q, text: "@scout where do film people hang out?" });
    const reply = await settle(() => comments(ola, q), (c) => c.some((x) => x.author?.username === "scout"));
    assert.match(reply.find((x) => x.author?.username === "scout")!.text, /Community: c\/film-lab/);
  }));

// ------------------------------------------------------------------------------- paged conversations

test("conversations page by top-level comment: every root exactly once, in order, with its replies", () =>
  withApp(async (t) => {
    const { me: maya } = await person(t, "maya");
    const { me: leo } = await person(t, "leo");
    const postId = await post(t, "maya", "Busy thread");
    // Every root written at the same instant (only Date is frozen): page boundaries fall inside ties.
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const roots: string[] = [];
    try {
      for (let i = 0; i < 23; i++) roots.push(await (i % 2 ? leo : maya).mutation(api.comments.create, { postId, text: `root ${i}` }));
    } finally {
      mock.timers.reset();
    }
    const r0 = roots[0]!;
    const reply = await leo.mutation(api.comments.create, { postId, text: "reply", parentId: r0 });
    await maya.mutation(api.comments.create, { postId, text: "reply to reply", parentId: reply });

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await maya.query(api.comments.thread, { postId, limit: 5, ...(cursor ? { cursor } : {}) });
      const pageRoots = page.comments.filter((c) => c.parentId === null);
      assert.ok(pageRoots.length <= 5);
      seen.push(...pageRoots.map((c) => c.id));
      // Replies travel with their root.
      if (pageRoots.some((c) => c.id === r0)) assert.deepEqual(page.comments.filter((c) => c.parentId !== null).map((c) => c.text), ["reply", "reply to reply"]);
      assert.equal(page.total, 25);
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 20);
    assert.equal(seen.length, 23);
    assert.deepEqual(new Set(seen), new Set(roots), "every root exactly once");
    await assert.rejects(maya.query(api.comments.thread, { postId, cursor: "nonsense" }), { code: "INVALID_ARGUMENT" });
  }));

test("cancelling a scheduled post releases its images, unless another scheduled post still uses them", () =>
  withApp(async (t) => {
    const { me: maya } = await person(t, "maya");
    const a = await photo(t, maya);
    const b = await photo(t, maya);
    const later = Date.now() + 3_600_000;
    const first = await maya.mutation(api.tasks.create, { kind: "publish", draft: { text: "one", media: [a, b] }, runAt: later });
    const second = await maya.mutation(api.tasks.create, { kind: "publish", draft: { text: "two", media: [b] }, runAt: later });
    const files = async () => Object.fromEntries((await t.runtime.instance.handle("test").collection<{ id: string; deletedAt?: string }>("files").find({})).map((f) => [f.id, Boolean(f.deletedAt)]));

    await maya.mutation(api.tasks.cancel, { id: first });
    await t.runtime.runServices();
    let state = await files();
    assert.equal(state[a.fileId], true, "a: only the cancelled post used it");
    assert.equal(state[b.fileId], false, "b: the other scheduled post still needs it");

    await maya.mutation(api.tasks.cancel, { id: second });
    await t.runtime.runServices();
    state = await files();
    assert.equal(state[b.fileId], true);
  }));

// ----------------------------------------------------------------------------- platform capabilities

test("the home feed is one set query per source, served by FeltDB as an index merge over Frame's ordered index", () =>
  withApp(async (t) => {
    const { me } = await person(t, "reader");
    const authors: string[] = [];
    for (let i = 0; i < 30; i++) {
      const { me: who, profileId } = await person(t, `author${i}`);
      authors.push(profileId);
      if (i < 12) await me.mutation(api.follows.create, { profileId });
      for (let k = 0; k < 4; k++) await who.mutation(api.posts.create, { text: `${i}/${k}` });
    }
    // Frame's own feed, paged to the end: every followed author's post exactly once, newest first.
    const seen: string[] = [];
    let cursor: number | undefined;
    do {
      const page = await me.query(api.posts.feed, { limit: 7, ...(cursor !== undefined ? { cursor } : {}) });
      seen.push(...page.posts.map((p) => p.text));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    assert.equal(seen.length, 48);
    // The shape the feed sends FeltDB, explained and run: an index merge reading about one page.
    const followed = authors.slice(0, 12);
    const db = t.runtime.instance.handle("test") as unknown as { explain(q: unknown): Promise<{ plan: string; index: string }>; query(q: unknown): Promise<{ plan: { accessMethod: string; recordsExamined: number } }> };
    const shape = { collection: "posts", where: [{ field: "authorId", in: followed }, { field: "createdAt", lt: Date.now() + 1000 }], orderBy: [{ field: "createdAt", direction: "desc" }], limit: 8 };
    const explained = await db.explain(shape);
    assert.deepEqual([explained.plan, explained.index], ["index-merge", "posts_authorId_createdAt_ordered"]);
    const run = await db.query(shape);
    assert.equal(run.plan.accessMethod, "index_merge");
    assert.ok(run.plan.recordsExamined <= 9, `read ${run.plan.recordsExamined} of 120 posts for a page of 8`);
  }));

test("photo links are FeltKit's cacheable kind (stable within their window) and come in derived sizes", () =>
  withApp(async (t) => {
    const { me: maya } = await person(t, "maya");
    const { me: leo } = await person(t, "leo");
    const postId = await post(t, "maya", "x");
    const fileId = (await leo.query(api.posts.get, { id: postId }))!.media[0]!.fileId;
    const a = await leo.query(api.posts.mediaLink, { fileId, variant: "grid" });
    const b = await leo.query(api.posts.mediaLink, { fileId, variant: "grid" });
    assert.equal(a.url, b.url, "the same URL again: the browser keeps its copy");
    assert.notEqual((await maya.query(api.posts.mediaLink, { fileId, variant: "grid" })).url, a.url, "another person gets their own URL");
    assert.notEqual((await leo.query(api.posts.mediaLink, { fileId, variant: "avatar" })).url, a.url, "another size, another URL");
  }));

// ------------------------------------------------------------------------------------- durability

test("state survives a restart", () =>
  withApp(async (t) => {
    await person(t, "maya");
    const postId = await post(t, "maya", "Durable");
    await person(t, "leo");
    await t.as(member("leo")).mutation(api.reactions.set, { postId, kind: "wow" });
    await t.restart();
    const card = (await t.as(member("leo")).query(api.posts.get, { id: postId }))!;
    assert.equal(card.text, "Durable");
    assert.equal(card.reactions.counts.wow, 1);
    assert.equal((await t.as(member("maya")).query(api.inbox.list, {})).groups.length, 1);
  }));
