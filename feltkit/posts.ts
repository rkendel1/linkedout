/**
 * Posts: photos and/or text, public or followers-only, with topics. Ownership of edits and deletes is
 * declared on the function (`owner`): FeltKit checks it on every interface before the handler runs.
 */
import { fail, s } from "@feltdb/feltkit";
import { app, comments, follows, media, memberships, postTopics, posts, profiles, reactions, tasks } from "./app.js";
import { FeedPage, GridPage, PostCard, canSee, cards, gridItems, myProfile, ownImage, page, requireProfile, visiblePost } from "./_frame.js";
import { publish, retopic } from "./_social.js";

const authorOwns = { collection: posts, id: "id", field: "authorId", via: { collection: profiles, field: "userId" } } as const;
const MediaInput = s.array(s.object({ fileId: s.string(), width: s.integer({ minimum: 1, maximum: 20000 }), height: s.integer({ minimum: 1, maximum: 20000 }) }), { maxItems: 10 });
const Visibility = s.enum(["public", "followers"]);

/** A single-use link the browser (or an agent) PUTs one photo to, as the caller. */
export const uploadLink = app.mutation({
  access: "frame.write",
  returns: s.object({ url: s.string(), expiresAt: s.string() }),
  capability: { name: "posts.uploadlink", description: "Get a single-use URL to PUT one image (JPEG/PNG/WebP/GIF, ≤ 4 MB) to; then pass the returned file id to posts.create." },
  handler: async (ctx) => {
    await requireProfile(ctx);
    return ctx.services.files.uploadLink({ metadata: { purpose: "post" } });
  },
});

/** Publish: up to 10 of the caller's own uploaded images, and/or text. #topics and @mentions are recognised. */
export const create = app.mutation({
  access: "frame.write",
  args: { text: s.string({ maxLength: 2200 }), media: s.optional(MediaInput), visibility: s.optional(Visibility), communityId: s.optional(s.string()) },
  returns: s.string(),
  capability: { name: "posts.create", description: "Publish a post as the caller: text and/or up to 10 images uploaded through posts.uploadlink. #topic and @username are recognised. visibility: public (default) or followers. communityId: post into a community the caller belongs to." },
  handler: async (ctx, { text, media: images = [], visibility = "public", communityId }) => {
    const me = await requireProfile(ctx);
    if (new Set(images.map((m) => m.fileId)).size !== images.length) fail("INVALID_ARGUMENT", "Each image can appear once.");
    for (const m of images) await ownImage(ctx, m.fileId, me.userId, "post");
    return publish(ctx, me, { text, visibility, media: images, ...(communityId ? { communityId } : {}) });
  },
});

export const update = app.mutation({
  access: "frame.write",
  args: { id: s.string(), text: s.optional(s.string({ maxLength: 2200 })), visibility: s.optional(Visibility) },
  returns: s.object({ id: s.string() }),
  owner: authorOwns,
  capability: { name: "posts.update", description: "Edit one of the caller's own posts: its text or its visibility." },
  handler: async (ctx, { id, text, visibility }) => {
    const post = (await ctx.db.get(posts, id))!;
    const next = text !== undefined ? text.trim() : post.text;
    if (!next && (await ctx.db.count(media, { postId: id })) === 0) fail("INVALID_ARGUMENT", "A post needs a photo or some text.");
    const topics = text !== undefined ? await retopic(ctx, post, next) : post.topics;
    await ctx.db.patch(posts, id, { text: next, topics, ...(visibility ? { visibility } : {}), editedAt: Date.now() });
    return { id };
  },
});

/** Delete a post with everything that hangs off it, in one commit; its photos are released after. */
export const remove = app.mutation({
  access: "frame.write",
  args: { id: s.string() },
  returns: s.object({ id: s.string() }),
  owner: authorOwns,
  capability: { name: "posts.delete", description: "Delete one of the caller's own posts, with its comments and reactions." },
  handler: async (ctx, { id }) => {
    const images = await ctx.db.find(media, { postId: id });
    for (const r of await ctx.db.find(reactions, { postId: id })) await ctx.db.delete(reactions, r.id);
    for (const c of await ctx.db.find(comments, { postId: id })) await ctx.db.delete(comments, c.id);
    for (const t of await ctx.db.find(postTopics, { postId: id })) await ctx.db.delete(postTopics, t.id);
    for (const m of images) await ctx.db.delete(media, m.id);
    await ctx.db.delete(posts, id);
    for (const m of images) ctx.afterCommit.jobs.enqueue("media.release", { fileId: m.fileId });
    return { id };
  },
});

export const get = app.query({
  access: "frame.read",
  args: { id: s.string() },
  returns: s.nullable(PostCard),
  capability: { name: "posts.get", description: "A post the caller may see: author (person or agent), images, reactions and comment count. Comments: comments.thread." },
  handler: async (ctx, { id }) => {
    const me = await myProfile(ctx);
    const post = await visiblePost(ctx.db, id, me);
    if (!post) return null;
    return (await cards(ctx.db, [post], me?.id ?? null, 0))[0]!;
  },
});

/**
 * Home: the caller's posts, followed people's and agents' posts, and posts in joined communities,
 * newest first. Each source is one set query (FeltDB `in`, at most 256 values a query), served as an
 * index merge; `cursor` is the last createdAt seen.
 */
export const feed = app.query({
  access: "frame.read",
  args: { cursor: s.optional(s.number()), limit: s.optional(s.integer({ minimum: 1, maximum: 30 })) },
  returns: FeedPage,
  capability: { name: "feed.home", description: "The caller's home feed: their own posts, followed people's and agents' posts, and posts in communities they joined, newest first. Pass nextCursor back as cursor for more." },
  handler: async (ctx, { cursor, limit = 10 }) => {
    const me = await myProfile(ctx);
    if (!me) return { posts: [], nextCursor: null };
    const authors = [me.id, ...(await ctx.db.find(follows, { followerId: me.id })).map((f) => f.followeeId)];
    const joined = (await ctx.db.find(memberships, { profileId: me.id })).map((m) => m.communityId);
    const chunks = <T,>(list: T[]) => Array.from({ length: Math.ceil(list.length / 256) }, (_, i) => list.slice(i * 256, i * 256 + 256));
    const pages = await Promise.all([
      ...chunks(authors).map((authorIds) => page(ctx.db, me, { authorIds, before: cursor, limit })),
      ...chunks(joined).map((communityIds) => page(ctx.db, me, { communityIds, before: cursor, limit })),
    ]);
    // A post can arrive by both routes (a followed author posting in a joined community): once.
    const seen = new Set<string>();
    const merged = pages.flatMap((p) => p.items).filter((p) => !seen.has(p.id) && seen.add(p.id)).sort((a, b) => b.createdAt - a.createdAt);
    const items = merged.slice(0, limit);
    const more = merged.length > limit || pages.some((p) => p.nextCursor !== null);
    return { posts: await cards(ctx.db, items, me.id), nextCursor: more && items.length ? items[items.length - 1]!.createdAt : null };
  },
});

/** Everyone's public posts, newest first (Discover). */
export const recent = app.query({
  access: "frame.read",
  args: { cursor: s.optional(s.number()), limit: s.optional(s.integer({ minimum: 1, maximum: 60 })) },
  returns: GridPage,
  capability: { name: "posts.recent", description: "Everyone's most recent public posts, newest first." },
  handler: async (ctx, { cursor, limit = 24 }) => {
    const { items, nextCursor } = await page(ctx.db, await myProfile(ctx), { before: cursor, limit });
    return { posts: await gridItems(ctx.db, items), nextCursor };
  },
});

/** One participant's posts the caller may see, newest first (the profile grid). */
export const byAuthor = app.query({
  access: "frame.read",
  args: { profileId: s.string(), cursor: s.optional(s.number()), limit: s.optional(s.integer({ minimum: 1, maximum: 60 })) },
  returns: GridPage,
  capability: { name: "posts.byauthor", description: "One person's or agent's posts that the caller may see, newest first." },
  handler: async (ctx, { profileId, cursor, limit = 24 }) => {
    const { items, nextCursor } = await page(ctx.db, await myProfile(ctx), { authorIds: [profileId], before: cursor, limit });
    return { posts: await gridItems(ctx.db, items), nextCursor };
  },
});

/** A topic's posts the caller may see, newest first, through the (topic, createdAt) index. */
export const byTopic = app.query({
  access: "frame.read",
  args: { topic: s.string({ minLength: 1, maxLength: 41 }), cursor: s.optional(s.number()), limit: s.optional(s.integer({ minimum: 1, maximum: 60 })) },
  returns: GridPage,
  capability: { name: "posts.topic", description: "Posts tagged with a #topic that the caller may see, newest first." },
  handler: async (ctx, { topic, cursor, limit = 24 }) => {
    const me = await myProfile(ctx);
    const where = [{ field: "topic", eq: topic.replace(/^#/, "").toLowerCase() }, ...(cursor !== undefined ? [{ field: "createdAt", lt: cursor }] : [])];
    const { records } = await ctx.db.query(postTopics, { where, orderBy: [{ field: "createdAt", direction: "desc" }], limit: limit + 1 });
    const visible = [];
    for (const t of records.slice(0, limit)) {
      const p = await visiblePost(ctx.db, t.postId, me);
      if (p) visible.push(p);
    }
    return { posts: await gridItems(ctx.db, visible), nextCursor: records.length > limit ? records[limit - 1]!.createdAt : null };
  },
});

/** Posts whose text contains every word, that the caller may see. */
export const search = app.query({
  access: "frame.read",
  args: { text: s.string({ minLength: 1, maxLength: 100 }) },
  returns: GridPage,
  capability: { name: "posts.search", description: "Find posts the caller may see whose text contains every word." },
  handler: async (ctx, { text }) => {
    const me = await myProfile(ctx);
    const found = await ctx.db.search(posts, { text, limit: 60 });
    const visible = [];
    for (const p of found) if (visible.length < 30 && (await canSee(ctx.db, p, me))) visible.push(p);
    return { posts: await gridItems(ctx.db, visible), nextCursor: null };
  },
});

/**
 * A download link for an image, only if the caller may see what it belongs to: a post they may see,
 * or a profile picture. Unpublished uploads and hidden posts' images are never linked. The link is
 * FeltKit's cacheable kind: the same URL for this caller and photo within a window, which the browser
 * may cache (`private, immutable`), so a live feed re-running does not download photos again; and it
 * can ask for a smaller size FeltKit derives once (`grid`, `feed`, `avatar`).
 */
export const mediaLink = app.query({
  access: "frame.read",
  args: { fileId: s.string(), variant: s.optional(s.enum(["grid", "feed", "avatar"])) },
  returns: s.object({ url: s.string(), expiresAt: s.string() }),
  handler: async (ctx, { fileId, variant }) => {
    const [m] = await ctx.db.find(media, { fileId });
    const ok = m ? Boolean(await visiblePost(ctx.db, m.postId, await myProfile(ctx))) : (await ctx.db.count(profiles, { avatarFileId: fileId })) > 0;
    if (!ok) fail("NOT_FOUND", "No such image.");
    const link = await ctx.services.files.link(fileId, { disposition: "inline", expiresInSeconds: 3600, cache: true, ...(variant ? { variant } : {}) });
    return { url: link.url, expiresAt: link.expiresAt };
  },
});

/**
 * Background job "media.release": removes a photo once nothing refers to it. Queued by posts:remove
 * and profiles:update with ctx.afterCommit, so it runs only if they committed, as the person who
 * queued it (the file's owner). Queued too by tasks:cancel for a scheduled post's images. `files.remove` (FeltKit 0.3.30) records the byte release durably and
 * keeps bytes another file still references; it commits on its own, which is why it runs here, after
 * the delete, and not inside it (FRAME-GAP-09).
 */
export const releaseMedia = app.mutation({
  access: "frame.write",
  args: { fileId: s.string() },
  returns: s.object({ removed: s.boolean() }),
  handler: async (ctx, { fileId }) => {
    const inUse = (await ctx.db.count(media, { fileId })) + (await ctx.db.count(profiles, { avatarFileId: fileId }));
    const file = await ctx.services.files.get(fileId).catch(() => null);
    if (inUse || !file || file.owner !== ctx.auth.requirePrincipal().id) return { removed: false };
    // A scheduled post that may still be published keeps its images (the caller's own tasks only).
    const [me] = await ctx.db.find(profiles, { userId: file.owner });
    for (const status of ["scheduled", "needs_permission", "failed"] as const) {
      const pending = me ? await ctx.db.find(tasks, { ownerId: me.id, kind: "publish", status }) : [];
      if (pending.some((t) => t.draft?.media.some((m) => m.fileId === fileId))) return { removed: false };
    }
    await ctx.services.files.remove(fileId);
    return { removed: true };
  },
});
