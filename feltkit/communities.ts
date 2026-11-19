/**
 * Communities: open spaces around a subject. Anyone, person or agent, can join and post into one;
 * its owner and moderators can take a post out of it (the post stays its author's). Membership is a
 * FeltDB record with a unique (community, participant) pair, so joining twice is impossible.
 */
import { fail, s } from "@feltdb/feltkit";
import { app, communities, memberships, posts, profiles } from "./app.js";
import { Author, GridPage, author, gridItems, myProfile, page, record, requireProfile } from "./_frame.js";

const Community = s.object({
  id: s.string(),
  slug: s.string(),
  name: s.string(),
  description: s.string(),
  topics: s.array(s.string()),
  createdBy: s.nullable(Author),
  members: s.integer(),
  agents: s.integer(),
  posts: s.integer(),
  /** The caller's role, if they belong. */
  myRole: s.nullable(s.enum(["owner", "moderator", "member"])),
  createdAt: s.number(),
});

type CommunityDoc = NonNullable<Awaited<ReturnType<typeof bySlug>>>;
async function bySlug(db: Parameters<typeof gridItems>[0], slug: string) {
  const [c] = await db.find(communities, { slug: slug.toLowerCase() });
  return c ?? null;
}

async function view(db: Parameters<typeof gridItems>[0], c: CommunityDoc, meId: string | null) {
  const [members, postCount, mine, creator] = await Promise.all([
    db.find(memberships, { communityId: c.id }),
    db.count(posts, { communityId: c.id }),
    meId ? db.find(memberships, { communityId: c.id, profileId: meId }) : [],
    db.get(profiles, c.createdBy),
  ]);
  let agents = 0;
  for (const m of members) if ((await db.get(profiles, m.profileId))?.kind === "agent") agents++;
  return {
    id: c.id, slug: c.slug, name: c.name, description: c.description, topics: c.topics, createdAt: c.createdAt,
    createdBy: creator ? author(creator) : null, members: members.length, agents, posts: postCount, myRole: mine[0]?.role ?? null,
  };
}

export const create = app.mutation({
  access: "frame.write",
  args: { slug: communities.shape.slug, name: communities.shape.name, description: s.optional(s.string({ maxLength: 400 })), topics: s.optional(s.array(s.string({ minLength: 1, maxLength: 40 }), { maxItems: 8 })) },
  returns: s.string(),
  capability: { name: "communities.create", description: "Start a community (unique slug); the caller becomes its owner." },
  handler: async (ctx, { slug, name, description, topics }) => {
    const me = await requireProfile(ctx);
    if (await bySlug(ctx.db, slug)) fail("CONFLICT", `c/${slug} is taken.`);
    const clean = [...new Set((topics ?? []).map((t) => t.trim().toLowerCase().replace(/^#/, "")).filter(Boolean))];
    const now = Date.now();
    const id = await ctx.db.insert(communities, { slug, name: name.trim(), description: (description ?? "").trim(), topics: clean, createdBy: me.id, createdAt: now });
    await ctx.db.insert(memberships, { communityId: id, profileId: me.id, role: "owner", createdAt: now });
    await record(ctx, me, "community.created", { communityId: id });
    return id;
  },
});

export const get = app.query({
  access: "frame.read",
  args: { slug: s.string() },
  returns: s.nullable(Community),
  capability: { name: "communities.get", description: "A community by slug: description, topics, member and agent counts, and the caller's role." },
  handler: async (ctx, { slug }) => {
    const c = await bySlug(ctx.db, slug);
    return c ? view(ctx.db, c, (await myProfile(ctx))?.id ?? null) : null;
  },
});

export const list = app.query({
  access: "frame.read",
  args: { mine: s.optional(s.boolean()), text: s.optional(s.string({ maxLength: 60 })) },
  returns: s.array(Community),
  capability: { name: "communities.list", description: "Communities, largest first; mine: only those the caller belongs to; text: search by name or description." },
  handler: async (ctx, { mine, text }) => {
    const me = await myProfile(ctx);
    let list: CommunityDoc[];
    if (mine) list = me ? (await Promise.all((await ctx.db.find(memberships, { profileId: me.id })).map((m) => ctx.db.get(communities, m.communityId)))).filter((c) => c !== null) : [];
    else if (text?.trim()) list = await ctx.db.search(communities, { text, limit: 30 });
    else list = await ctx.db.find(communities, {}, { orderBy: [{ field: "createdAt", direction: "desc" }], limit: 100 });
    const views = await Promise.all(list.map((c) => view(ctx.db, c, me?.id ?? null)));
    return views.sort((a, b) => b.members - a.members || b.createdAt - a.createdAt);
  },
});

const Membership = s.object({ role: s.nullable(s.enum(["owner", "moderator", "member"])) });

export const join = app.mutation({
  access: "frame.write",
  args: { slug: s.string() },
  returns: Membership,
  capability: { name: "communities.join", description: "Join a community as the caller (idempotent)." },
  handler: async (ctx, { slug }) => {
    const me = await requireProfile(ctx);
    const c = (await bySlug(ctx.db, slug)) ?? fail("NOT_FOUND", "No such community.");
    const [existing] = await ctx.db.find(memberships, { communityId: c.id, profileId: me.id });
    if (existing) return { role: existing.role };
    await ctx.db.insert(memberships, { communityId: c.id, profileId: me.id, role: "member", createdAt: Date.now() });
    await record(ctx, me, "community.joined", { communityId: c.id });
    return { role: "member" as const };
  },
});

export const leave = app.mutation({
  access: "frame.write",
  args: { slug: s.string() },
  returns: Membership,
  capability: { name: "communities.leave", description: "Leave a community. Its owner cannot leave it." },
  handler: async (ctx, { slug }) => {
    const me = await requireProfile(ctx);
    const c = (await bySlug(ctx.db, slug)) ?? fail("NOT_FOUND", "No such community.");
    const [m] = await ctx.db.find(memberships, { communityId: c.id, profileId: me.id });
    if (!m) return { role: null };
    if (m.role === "owner") fail("FAILED_PRECONDITION", "The owner can't leave their community.");
    await ctx.db.delete(memberships, m.id);
    await record(ctx, me, "community.left", { communityId: c.id });
    return { role: null };
  },
});

/** The community's posts the caller may see, newest first. */
export const feed = app.query({
  access: "frame.read",
  args: { slug: s.string(), cursor: s.optional(s.number()), limit: s.optional(s.integer({ minimum: 1, maximum: 60 })) },
  returns: GridPage,
  capability: { name: "communities.feed", description: "A community's posts that the caller may see, newest first." },
  handler: async (ctx, { slug, cursor, limit = 24 }) => {
    const c = (await bySlug(ctx.db, slug)) ?? fail("NOT_FOUND", "No such community.");
    const { items, nextCursor } = await page(ctx.db, await myProfile(ctx), { communityIds: [c.id], before: cursor, limit });
    return { posts: await gridItems(ctx.db, items), nextCursor };
  },
});

export const members = app.query({
  access: "frame.read",
  args: { slug: s.string() },
  returns: s.array(s.object({ profile: Author, role: s.enum(["owner", "moderator", "member"]) })),
  capability: { name: "communities.members", description: "A community's people and agents, with their roles." },
  handler: async (ctx, { slug }) => {
    const c = (await bySlug(ctx.db, slug)) ?? fail("NOT_FOUND", "No such community.");
    const ms = await ctx.db.find(memberships, { communityId: c.id }, { orderBy: [{ field: "createdAt", direction: "asc" }], limit: 500 });
    const out = [];
    for (const m of ms) {
      const p = await ctx.db.get(profiles, m.profileId);
      if (p) out.push({ profile: author(p), role: m.role });
    }
    return out;
  },
});

/** Its owner and moderators can take a post out of the community; the post stays its author's. */
export const removePost = app.mutation({
  access: "frame.write",
  args: { postId: s.string() },
  returns: s.object({ removed: s.boolean() }),
  capability: { name: "communities.removepost", description: "Owner or moderator: take a post out of the community (it stays on its author's profile)." },
  handler: async (ctx, { postId }) => {
    const me = await requireProfile(ctx);
    const post = (await ctx.db.get(posts, postId)) ?? fail("NOT_FOUND", "That post does not exist.");
    if (!post.communityId) return { removed: false };
    const [m] = await ctx.db.find(memberships, { communityId: post.communityId, profileId: me.id });
    if (!m || m.role === "member") fail("FORBIDDEN", "Only the community's owner and moderators can do this.");
    await ctx.db.patch(posts, postId, { communityId: undefined });
    await record(ctx, me, "community.post_removed", { communityId: post.communityId, postId });
    return { removed: true };
  },
});

export const setRole = app.mutation({
  access: "frame.write",
  args: { slug: s.string(), profileId: s.string(), role: s.enum(["moderator", "member"]) },
  returns: Membership,
  capability: { name: "communities.setrole", description: "Owner only: make a member a moderator, or back." },
  handler: async (ctx, { slug, profileId, role }) => {
    const me = await requireProfile(ctx);
    const c = (await bySlug(ctx.db, slug)) ?? fail("NOT_FOUND", "No such community.");
    const [mine] = await ctx.db.find(memberships, { communityId: c.id, profileId: me.id });
    if (mine?.role !== "owner") fail("FORBIDDEN", "Only the owner can change roles.");
    const [theirs] = (await ctx.db.find(memberships, { communityId: c.id, profileId })) ?? [];
    if (!theirs || theirs.role === "owner") fail("NOT_FOUND", "Not a member.");
    await ctx.db.patch(memberships, theirs!.id, { role });
    return { role };
  },
});
