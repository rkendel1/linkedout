/**
 * End to end against the production build (`feltkit build` + `feltkit start`) on a fresh state
 * directory: real HTTP, real file transfers, MCP as an agent, a real browser at phone and desktop
 * sizes, a server restart on the same state, concurrent writers, the resident agents, and delegation
 * decided by the private AuthBoundry FeltKit runs in production. Nothing is mocked.
 *
 *   npm run test:e2e      (builds first; needs Playwright's Chromium and ImageMagick's `convert`)
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createApi, createClient } from "@feltdb/feltkit/client";

const api = createApi();
const require = createRequire(import.meta.url);
const { chromium, devices } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright").catch(() => require("/opt/node22/lib/node_modules/playwright"));
const PORT = Number(process.env.E2E_PORT ?? 4317);
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = mkdtempSync(join(tmpdir(), "frame-e2e-"));
const PASSWORD = "e2e-password-123";
let server;
const FELTKIT = join(process.cwd(), "node_modules", "@feltdb", "feltkit", "bin", "feltkit.js");
// Local production state only: never a FeltDB server or Managed FeltDB this machine may be configured for.
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("FELTDB_")));
ENV.FELTKIT_STATE_DIR = join(STATE, "state");
// Production keeps the private AuthBoundry's secrets in a vault only with an operator-held key.
ENV.FELTKIT_CREDENTIAL_VAULT = "1";
ENV.FELTKIT_CREDENTIAL_VAULT_KEY = randomBytes(32).toString("base64");

function photo(w = 900, h = 1125, color = "steelblue") {
  const file = join(STATE, `${w}x${h}-${color}.jpg`);
  execFileSync("convert", ["-size", `${w}x${h}`, `gradient:${color}-white`, "-quality", "80", file]);
  return { file, bytes: readFileSync(file) };
}

async function start() {
  // The FeltKit binary itself (not via npx), so stopping it really stops the server.
  server = spawn(process.execPath, [FELTKIT, "start", "--port", String(PORT)], { env: ENV, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 120; i++) {
    const ok = await fetch(`${BASE}/_feltkit/health`).then((r) => r.ok, () => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server did not start:\n${log}`);
}
async function stop() {
  if (!server) return;
  const exited = new Promise((r) => server.once("exit", r));
  server.kill("SIGTERM");
  await exited;
  server = undefined;
  assert.equal(await fetch(`${BASE}/_feltkit/health`).then(() => "up", () => "down"), "down", "the server really stopped");
}

/** A signed-in client for a new built-in account (bearer session, as a non-browser client). */
async function person(username, { profile = true } = {}) {
  let token = null;
  const client = createClient({ url: BASE, session: "bearer", tokens: { get: () => token, set: (t) => void (token = t) }, context: false });
  await client.signUp({ email: `${username.replace(/\./g, "-")}@e2e.test`, password: PASSWORD, name: username });
  const id = profile ? await client.mutation(api.profiles.create, { username, displayName: username }) : null;
  return Object.assign(client, { profileId: id, username, token: () => token });
}
async function image(client, color) {
  const { bytes } = photo(900, 1125, color);
  const file = await client.uploadFile(await client.mutation(api.posts.uploadLink), bytes, { name: "p.jpg", contentType: "image/jpeg" });
  return { fileId: file.id, width: 900, height: 1125 };
}
async function post(client, text, ...colors) {
  const media = [];
  for (const c of colors) media.push(await image(client, c));
  return client.mutation(api.posts.create, { text, media });
}
/** Wait for after-commit work (agents) by polling state; bounded. */
async function until(read, done, ms = 15000) {
  const end = Date.now() + ms;
  let v = await read();
  while (!done(v) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 150));
    v = await read();
  }
  assert.ok(done(v), JSON.stringify(v).slice(0, 400));
  return v;
}
const retrying = async (fn) => {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!e.retryable || i > 25) throw e;
    }
  }
};

before(async () => start());
after(async () => {
  await stop();
  rmSync(STATE, { recursive: true, force: true });
});

let alice, bob, alicePost;

test("accounts, profiles, multi-photo upload over HTTP, feed composition", async () => {
  alice = await person("alice");
  bob = await person("bob");
  const s1 = await alice.session();
  const s2 = await bob.session();
  assert.ok(s1.principal.id && s1.principal.id !== s2.principal.id, "each account is its own principal");

  alicePost = await post(alice, "Harbour at dusk #film", "darkorange", "steelblue");
  const card = await bob.query(api.posts.get, { id: alicePost });
  assert.equal(card.media.length, 2);
  // The photo itself, through the link Frame issues: real bytes, an image type, sandboxed.
  const link = await bob.query(api.posts.mediaLink, { fileId: card.media[0].fileId });
  const res = await fetch(BASE + link.url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/jpeg");
  assert.match(res.headers.get("content-security-policy") ?? "", /sandbox/);
  // FRAME-GAP-01, closed: a cacheable link. The browser may keep the bytes; asking again gives the same URL.
  assert.match(res.headers.get("cache-control") ?? "", /^private, max-age=\d+, immutable$/);
  const etag = res.headers.get("etag");
  assert.ok(etag);
  assert.equal((await bob.query(api.posts.mediaLink, { fileId: card.media[0].fileId })).url, link.url);
  assert.equal((await fetch(BASE + link.url, { headers: { "if-none-match": etag } })).status, 304);
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer()).slice(0, 3)], [0xff, 0xd8, 0xff]);
  // FRAME-GAP-06, closed: a smaller size, derived by FeltKit (served once ready; the original until then).
  const grid = await bob.query(api.posts.mediaLink, { fileId: card.media[0].fileId, variant: "grid" });
  let variant;
  for (let i = 0; i < 20 && variant !== "grid"; i++) variant = (await fetch(BASE + grid.url)).headers.get("x-feltkit-variant");
  assert.equal(variant, "grid");
  assert.equal((await fetch(`${BASE}/api/files/fkf_${"x".repeat(30)}`)).status, 404);

  assert.equal((await bob.query(api.posts.feed, {})).posts.length, 0, "bob follows nobody yet");
  await bob.mutation(api.follows.create, { profileId: alice.profileId });
  assert.deepEqual((await bob.query(api.posts.feed, {})).posts.map((p) => p.text), ["Harbour at dusk #film"]);
});

test("a non-image upload cannot become a post; an upload link works once", async () => {
  const link = await alice.mutation(api.posts.uploadLink);
  const file = await alice.uploadFile(link, new TextEncoder().encode("<html>not a photo</html>"), { name: "x.jpg", contentType: "image/jpeg" });
  await assert.rejects(alice.mutation(api.posts.create, { text: "x", media: [{ fileId: file.id, width: 1, height: 1 }] }), { code: "INVALID_ARGUMENT" });
  const again = await fetch(BASE + link.url, { method: "PUT", body: "again" });
  assert.equal(again.status, 404, "single use");
});

test("unauthorized operations are refused over HTTP", async () => {
  const mallory = await person("mallory");
  await assert.rejects(mallory.mutation(api.posts.remove, { id: alicePost }), { code: "FORBIDDEN" });
  const comment = await bob.mutation(api.comments.create, { postId: alicePost, text: "lovely" });
  await assert.rejects(mallory.mutation(api.comments.remove, { id: comment }), { code: "FORBIDDEN" });
  // Raw HTTP without a session, and with a forged actor argument.
  const anon = await fetch(`${BASE}/api/mutation/reactions%3Aset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args: { postId: alicePost, kind: "like" } }) });
  assert.equal(anon.status, 401);
  await assert.rejects(mallory.mutation(api.reactions.set, { postId: alicePost, kind: "like", profileId: alice.profileId }), { code: "INVALID_ARGUMENT" });
  assert.equal((await alice.query(api.comments.thread, { postId: alicePost })).comments.length, 1);
});

test("delegation in production: AuthBoundry allows, then refuses after revocation", async () => {
  await alice.mutation(api.tasks.grant, { capability: "frame.react" });
  await alice.mutation(api.tasks.create, { kind: "react" });
  const c1 = await bob.mutation(api.comments.create, { postId: alicePost, text: "The second frame!" });
  const who = await until(() => bob.query(api.reactions.list, { postId: alicePost, commentId: c1 }), (l) => l.length === 1);
  assert.deepEqual([who[0].profile.username, who[0].via.username, who[0].kind], ["alice", "concierge", "support"]);
  await alice.mutation(api.tasks.revoke, { capability: "frame.react" });
  const c2 = await bob.mutation(api.comments.create, { postId: alicePost, text: "And again" });
  const tasks = await until(() => alice.query(api.tasks.list), (l) => l[0].status === "needs_permission");
  assert.match(tasks[0].error, /revoked/);
  assert.equal((await bob.query(api.reactions.list, { postId: alicePost, commentId: c2 })).length, 0);
});

test("an external agent joins over MCP: sees what it may call, participates as itself, works with Scout", async () => {
  // An agent's session is issued by the operator on the host. Against a running production server
  // that needs a verified operator sign-in; with the server stopped the CLI opens the state directly.
  await stop();
  const out = execFileSync(process.execPath, [FELTKIT, "session", "create", "--id", "curator", "--type", "agent", "--role", "agent", "--ttl", "1", "--env", "production", "--json"], { env: ENV, stdio: ["ignore", "pipe", "pipe"] });
  const token = JSON.parse(String(out)).token;
  await start();
  let n = 0;
  const call = async (method, params) => {
    const res = await fetch(`${BASE}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }) });
    const body = JSON.parse((await res.text()).replace(/^data: /m, ""));
    if (body.error) throw Object.assign(new Error(body.error.message), body.error);
    return body.result;
  };
  // A tool result is the capability's JSON output as text; a refusal is isError with "CODE: message".
  const tool = async (name, args = {}) => {
    const r = await call("tools/call", { name, arguments: args });
    if (r.isError) throw new Error(r.content[0].text);
    return JSON.parse(r.content[0].text);
  };
  await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
  const tools = (await call("tools/list")).tools.map((t) => t.name);
  for (const t of ["feed_home", "posts_create", "reactions_set", "comments_create", "comments_thread", "follows_create", "discover_search", "agents_directory", "ecosystem_capabilities", "agents_requestsponsor", "communities_join", "communities_feed"]) assert.ok(tools.includes(t), t);
  assert.ok(!tools.some((t) => /^(notifications_send|files_)/.test(t)), "service operations are not offered to agents");
  // FRAME-GAP-10, closed by FeltKit 0.3.30: discovery shows only what this caller may invoke.
  assert.ok(!tools.some((t) => t.startsWith("feltkit_agent")), "no FeltKit agent tools without their permission");
  assert.ok(!tools.some((t) => /^(delegation|tasks)_(grant|revoke|create)/.test(t)), "an agent is not shown a person's delegation operations");
  // ...and an unlisted one called directly is refused the same way.
  await assert.rejects(tool("delegation_grant", { capability: "frame.publish" }), /FORBIDDEN|not found|Unknown/i);

  await tool("profiles_create", { username: "curator.bot", displayName: "Curator", skills: ["curation"] });
  const found = await tool("discover_search", { text: "alice" });
  assert.equal(found.people[0].username, "alice");
  await tool("follows_create", { profileId: found.people[0].id });
  assert.deepEqual((await tool("feed_home", {})).posts.map((p) => p.text), ["Harbour at dusk #film"]);
  await tool("reactions_set", { postId: alicePost, kind: "insightful" });
  const c = await tool("comments_create", { postId: alicePost, text: "Featured in today's picks. @scout, related?" });
  // Agent to agent: Scout (resident) answers the external agent in the thread, as itself.
  const thread = (await until(() => tool("comments_thread", { postId: alicePost }), (l) => l.comments.some((x) => x.author?.username === "scout" && x.parentId === c))).comments;
  assert.equal(thread.find((x) => x.author?.username === "scout").author.kind, "agent");
  // The agent posts a photo the way any client does: an upload link, then the bytes over HTTP.
  const link = await tool("posts_uploadlink");
  const put = await fetch(BASE + link.url, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: photo(800, 800, "seagreen").bytes });
  const fileId = (await put.json()).file.id;
  assert.ok(await tool("posts_create", { text: "Curated: soft light #film", media: [{ fileId, width: 800, height: 800 }] }));
  // The same ownership boundary as a person: it cannot delete Alice's post.
  await assert.rejects(tool("posts_delete", { id: alicePost }), /FORBIDDEN/);
  // Communities are open to agents too: it joins and posts into one Alice started.
  const lab = await alice.mutation(api.communities.create, { slug: "harbour-club", name: "Harbour Club", topics: ["film"] });
  await tool("communities_join", { slug: "harbour-club" });
  const inClub = await tool("posts_create", { text: "Picks of the week", communityId: lab });
  assert.deepEqual((await alice.query(api.communities.feed, { slug: "harbour-club" })).posts.map((p) => p.id), [inClub]);
  assert.equal((await alice.query(api.communities.get, { slug: "harbour-club" })).agents, 1);
  // It asks Alice to answer for it; she accepts; it is now verified, with her as owner.
  const req = await tool("agents_requestsponsor", { username: "alice" });
  await alice.mutation(api.agents.respondSponsor, { id: req.id, accept: true });
  const profile = await alice.query(api.profiles.get, { username: "curator.bot" });
  assert.deepEqual([profile.kind, profile.verified, profile.owner.username], ["agent", true, "alice"]);

  const inbox = (await alice.query(api.inbox.list, { filter: "agents", limit: 50 })).groups;
  const fromCurator = inbox.filter((g) => g.actors.some((a) => a.username === "curator.bot")).map((g) => g.type).sort();
  assert.deepEqual(fromCurator, ["agent.sponsor_requested", "post.commented", "post.reacted", "user.followed"]);
  assert.ok(inbox.every((g) => g.fromAgent));
});

test("concurrent reactions over HTTP keep exact counts", async () => {
  const fans = await Promise.all(Array.from({ length: 10 }, (_, i) => person(`fan${i}`)));
  await Promise.all(fans.map((f) => retrying(() => f.mutation(api.reactions.set, { postId: alicePost, kind: "like" }))));
  await Promise.all(Array.from({ length: 6 }, () => retrying(() => fans[0].mutation(api.reactions.set, { postId: alicePost, kind: "like" }))));
  const card = await alice.query(api.posts.get, { id: alicePost });
  assert.equal(card.reactions.counts.like, 10);
  assert.equal(card.reactions.total, 11, "ten fans and the curator agent, once each");
});

test("the browser app works on a phone and a desktop, live", async () => {
  const browser = await chromium.launch();
  try {
    for (const [name, options] of [["phone", devices["iPhone 13"]], ["desktop", { viewport: { width: 1360, height: 900 } }]]) {
      const ctx = await browser.newContext(options);
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(BASE);
      // Sign up through FeltKit's sign-in screen, then choose a username.
      await page.getByRole("tab", { name: /create account/i }).or(page.getByRole("button", { name: /create account/i })).first().click();
      await page.getByLabel(/name/i).first().fill(`Web ${name}`).catch(() => undefined);
      await page.getByLabel(/e-?mail/i).first().fill(`web-${name}@e2e.test`);
      await page.getByLabel(/password/i).first().fill(PASSWORD);
      await page.getByRole("button", { name: /create account|sign up/i }).last().click();
      await page.getByLabel("Username").fill(`web.${name}`);
      await page.getByRole("button", { name: "Continue" }).click();

      // Discover → search → follow Alice.
      await page.goto(`${BASE}/discover`);
      await page.getByLabel("Search").fill("alice");
      await page.locator(".person-row", { hasText: "alice" }).first().getByRole("link").first().click();
      await page.getByRole("button", { name: "Follow", exact: true }).click();
      await page.getByRole("button", { name: "Following", exact: true }).waitFor();

      // Home shows Alice's post; react to it.
      await page.goto(BASE);
      const card = page.locator("article.post-card", { hasText: "Harbour at dusk" });
      await card.waitFor();
      await card.locator(".photo.loaded img").first().waitFor({ timeout: 15000 });
      await card.getByRole("button", { name: "Choose a reaction" }).click();
      await card.getByRole("menuitem", { name: "Celebrate" }).click();
      await card.getByRole("button", { name: /Your reaction: celebrate/ }).waitFor();

      // Live: someone else comments; the open feed shows it without a reload.
      const text = `Hello from bob to ${name}`;
      await bob.mutation(api.comments.create, { postId: alicePost, text });
      await card.getByText(text).waitFor({ timeout: 10000 });

      // The conversation: reply to Bob in the thread.
      await card.getByRole("link", { name: "Comments", exact: true }).click();
      await page.waitForURL(/\/p\//);
      const bobs = page.locator("li.comment", { hasText: text }).first();
      await bobs.getByRole("button", { name: "Reply" }).first().click();
      await page.getByLabel("Comment").fill(`Reply from ${name}`);
      await page.getByRole("button", { name: "Post", exact: true }).click();
      await bobs.getByText(`Reply from ${name}`).waitFor();

      // Create a post with two real files, then see it and delete it.
      await page.goto(`${BASE}/create`);
      await page.locator('input[type="file"]').setInputFiles([photo(1600, 1200, "tomato").file, photo(1200, 1600, "gold").file]);
      await page.getByLabel("Text").fill(`From the ${name} #e2e`);
      await page.getByRole("button", { name: "Share" }).click();
      await page.waitForURL(/\/p\//);
      await page.getByText(`From the ${name}`).first().waitFor();
      await page.locator(".post-view .photo.loaded img").waitFor({ timeout: 15000 });
      assert.equal(await page.locator(".post-view .dots span").count(), 2);

      // Bob gets a reply notification from this person; Alice a reaction.
      assert.ok((await bob.query(api.inbox.list, {})).groups.some((g) => g.type === "comment.replied" && g.actors[0].username === `web.${name}`));
      assert.ok((await alice.query(api.inbox.list, { limit: 50 })).groups.some((g) => g.type === "post.reacted" && g.actors.some((a) => a.username === `web.${name}`)));
      // The notification page opens straight to the reply.
      const b = await bob.query(api.inbox.list, {});
      assert.ok(b.groups.find((g) => g.type === "comment.replied").link.commentId);
      assert.deepEqual(errors, [], `no page errors on ${name}`);
      // Layout: bottom bar on the phone, sidebar on the desktop.
      assert.equal(await page.locator(name === "phone" ? ".bottombar" : ".sidebar").isVisible(), true);
      assert.equal(await page.locator(name === "phone" ? ".sidebar" : ".bottombar").isVisible(), false);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, `no horizontal scroll on ${name}`);
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
});

test("everything survives a server restart on the same state", async () => {
  const before = await alice.query(api.posts.get, { id: alicePost });
  await stop();
  await start();
  await alice.signIn({ email: "alice@e2e.test", password: PASSWORD }).catch(() => undefined);
  const after = await alice.query(api.posts.get, { id: alicePost });
  assert.deepEqual(after.reactions, before.reactions);
  assert.equal(after.commentCount, before.commentCount);
  const link = await alice.query(api.posts.mediaLink, { fileId: after.media[1].fileId });
  assert.equal((await fetch(BASE + link.url)).status, 200, "the photo's bytes survived too");
  assert.ok((await alice.query(api.inbox.list, {})).groups.length > 0);
  // The delegation state lives in AuthBoundry's own store: still revoked after the restart.
  assert.equal((await alice.mutation(api.tasks.delegationStatus)).find((g) => g.capability === "frame.react").granted, false);
});
