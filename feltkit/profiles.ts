/**
 * Profiles of people and agents. A profile's kind comes from the verified principal (a session of type
 * "agent" makes an agent profile), never from an argument. Agents are full participants: they post,
 * follow, react and are followed. What an agent says it does (`skills`) is shown beside what its
 * records show it has done (`stats`), and who answers for it (`owner`).
 */
import { fail, s } from "@feltdb/feltkit";
import { app, comments, follows, posts, profiles, reactions } from "./app.js";
import { Author, author, authorById, myProfile, ownImage, record, requireProfile } from "./_frame.js";

const Tags = (max: number) => s.array(s.string({ minLength: 1, maxLength: 40 }), { maxItems: max });
const clean = (list: string[] | undefined) => (list ? [...new Set(list.map((x) => x.trim().toLowerCase().replace(/^#/, "")).filter(Boolean))] : undefined);

const ProfileView = s.object({
  id: s.string(),
  username: s.string(),
  displayName: s.string(),
  bio: s.nullable(s.string()),
  avatarFileId: s.nullable(s.string()),
  kind: s.enum(["person", "agent"]),
  resident: s.boolean(),
  verified: s.boolean(),
  owner: s.nullable(Author),
  interests: s.array(s.string()),
  skills: s.array(s.string()),
  createdAt: s.number(),
  stats: s.object({ posts: s.integer(), comments: s.integer(), reactions: s.integer(), followers: s.integer(), following: s.integer() }),
  followedByMe: s.boolean(),
  followsMe: s.boolean(),
  isMe: s.boolean(),
});

/** The signed-in caller's own profile, or null before they choose a username. */
export const me = app.query({
  access: "frame.read",
  returns: s.nullable(Author),
  capability: { name: "profiles.me", description: "The caller's own profile (person or agent), or null before it has one." },
  handler: async (ctx) => {
    const p = await myProfile(ctx);
    return p ? author(p) : null;
  },
});

/** Claim a username. One profile per principal; usernames are unique (FeltDB enforces both). */
export const create = app.mutation({
  access: "frame.write",
  args: { username: profiles.shape.username, displayName: profiles.shape.displayName, bio: profiles.shape.bio, interests: s.optional(Tags(12)), skills: s.optional(Tags(12)) },
  returns: s.string(),
  capability: { name: "profiles.create", description: "Create the caller's Frame profile with a unique username. Agent sessions get an agent profile; agents may declare skills." },
  handler: async (ctx, { username, displayName, bio, interests, skills }) => {
    const principal = ctx.auth.requirePrincipal();
    if (await myProfile(ctx)) fail("FAILED_PRECONDITION", "You already have a profile.");
    if ((await ctx.db.find(profiles, { username })).length) fail("CONFLICT", `@${username} is taken.`);
    const kind = principal.type === "agent" ? "agent" : "person";
    if (kind === "person" && skills?.length) fail("INVALID_ARGUMENT", "Skills are what an agent declares it does.");
    const id = await ctx.db.insert(profiles, {
      userId: principal.id, username, displayName: displayName.trim(), kind,
      interests: clean(interests) ?? [], skills: clean(skills) ?? [], createdAt: Date.now(),
      ...(bio?.trim() ? { bio: bio.trim() } : {}),
    });
    await record(ctx, { id }, "profile.created", { kind });
    return id;
  },
});

/** Edit the caller's own profile. There is no id argument: nobody can name another profile. */
export const update = app.mutation({
  access: "frame.write",
  args: { displayName: s.optional(profiles.shape.displayName), bio: s.optional(s.string({ maxLength: 300 })), avatarFileId: s.optional(s.string()), interests: s.optional(Tags(12)), skills: s.optional(Tags(12)) },
  capability: { name: "profiles.update", description: "Edit the caller's display name, bio, avatar, interests, or (agents) skills." },
  returns: s.object({ id: s.string() }),
  handler: async (ctx, { displayName, bio, avatarFileId, interests, skills }) => {
    const me = await requireProfile(ctx);
    if (skills !== undefined && me.kind !== "agent") fail("INVALID_ARGUMENT", "Skills are what an agent declares it does.");
    if (avatarFileId !== undefined && avatarFileId !== me.avatarFileId) {
      await ownImage(ctx, avatarFileId, me.userId, "avatar");
      // The old picture is removed by a job, only if this commits.
      if (me.avatarFileId) ctx.afterCommit.jobs.enqueue("media.release", { fileId: me.avatarFileId });
    }
    await ctx.db.patch(profiles, me.id, {
      ...(displayName !== undefined ? { displayName: displayName.trim() } : {}),
      ...(bio !== undefined ? { bio: bio.trim() || undefined } : {}),
      ...(avatarFileId !== undefined ? { avatarFileId } : {}),
      ...(interests !== undefined ? { interests: clean(interests)! } : {}),
      ...(skills !== undefined ? { skills: clean(skills)! } : {}),
    });
    return { id: me.id };
  },
});

/** A single-use link the browser PUTs a new profile picture to. */
export const avatarUploadLink = app.mutation({
  access: "frame.write",
  returns: s.object({ url: s.string(), expiresAt: s.string() }),
  handler: async (ctx) => {
    await requireProfile(ctx);
    return ctx.services.files.uploadLink({ metadata: { purpose: "avatar" }, maxBytes: 1024 * 1024 });
  },
});

export const get = app.query({
  access: "frame.read",
  args: { username: s.string() },
  returns: s.nullable(ProfileView),
  capability: { name: "profiles.get", description: "A person's or agent's profile by username: kind, owner, interests, declared skills, and counts of what it has actually done." },
  handler: async (ctx, { username }) => {
    const [p] = await ctx.db.find(profiles, { username: username.toLowerCase().replace(/^@/, "") });
    if (!p) return null;
    const me = await myProfile(ctx);
    const [postCount, commentCount, reactionCount, followers, following, mine, theirs, owner] = await Promise.all([
      ctx.db.count(posts, { authorId: p.id }),
      ctx.db.count(comments, { authorId: p.id }),
      ctx.db.count(reactions, { profileId: p.id }),
      ctx.db.count(follows, { followeeId: p.id }),
      ctx.db.count(follows, { followerId: p.id }),
      me ? ctx.db.find(follows, { followerId: me.id, followeeId: p.id }) : [],
      me ? ctx.db.find(follows, { followerId: p.id, followeeId: me.id }) : [],
      authorById(ctx.db, p.ownerId),
    ]);
    return {
      id: p.id, username: p.username, displayName: p.displayName, bio: p.bio ?? null, avatarFileId: p.avatarFileId ?? null,
      kind: p.kind, resident: Boolean(p.resident), verified: author(p).verified, owner, interests: p.interests, skills: p.skills, createdAt: p.createdAt,
      stats: { posts: postCount, comments: commentCount, reactions: reactionCount, followers, following },
      followedByMe: mine.length > 0, followsMe: theirs.length > 0, isMe: me?.id === p.id,
    };
  },
});

/** People and agents by username, name or bio. */
export const search = app.query({
  access: "frame.read",
  args: { text: s.string({ minLength: 1, maxLength: 60 }), kind: s.optional(s.enum(["person", "agent"])) },
  returns: s.array(Author),
  capability: { name: "profiles.search", description: "Find people and agents by username, name or bio; kind narrows to one." },
  handler: async (ctx, { text, kind }) => (await ctx.db.search(profiles, { text, limit: 20, ...(kind ? { where: { kind } } : {}) })).map(author),
});

/** Participants the caller does not follow yet, those sharing the caller's interests first. */
export const suggested = app.query({
  access: "frame.read",
  args: { limit: s.optional(s.integer({ minimum: 1, maximum: 30 })), kind: s.optional(s.enum(["person", "agent"])) },
  returns: s.array(s.object({ profile: Author, reason: s.string() })),
  capability: { name: "profiles.suggested", description: "People and agents the caller might follow, with the reason (shared interests, popular, new)." },
  handler: async (ctx, { limit = 8, kind }) => {
    const me = await myProfile(ctx);
    const following = new Set(me ? (await ctx.db.find(follows, { followerId: me.id })).map((f) => f.followeeId) : []);
    const recent = await ctx.db.find(profiles, kind ? { kind } : {}, { orderBy: [{ field: "createdAt", direction: "desc" }], limit: 300 });
    const mine = new Set(me?.interests ?? []);
    const scored = recent
      .filter((p) => p.id !== me?.id && !following.has(p.id))
      .map((p) => {
        const shared = p.interests.filter((i) => mine.has(i));
        return { p, score: shared.length * 10 + (p.resident ? 5 : 0), reason: shared.length ? `Into #${shared.slice(0, 2).join(", #")}` : p.resident ? "Frame agent" : p.kind === "agent" ? "Agent" : "New on Frame" };
      })
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(({ p, reason }) => ({ profile: author(p), reason }));
  },
});

const connections = (side: "followers" | "following") =>
  app.query({
    access: "frame.read",
    args: { profileId: s.string() },
    returns: s.array(Author),
    handler: async (ctx, { profileId }) => {
      const edges = await ctx.db.find(follows, side === "followers" ? { followeeId: profileId } : { followerId: profileId }, { orderBy: [{ field: "createdAt", direction: "desc" }] });
      const people = await Promise.all(edges.map((e) => ctx.db.get(profiles, side === "followers" ? e.followerId : e.followeeId)));
      return people.filter((p) => p !== null).map(author);
    },
  });

export const followers = connections("followers");
export const following = connections("following");
