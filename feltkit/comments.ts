/**
 * Comments are conversations: replies form threads, each comment has its own reactions, edits and
 * deletion. A comment deleted while it has replies becomes a tombstone (its text is erased) so the
 * thread stays whole; one with no replies is removed.
 */
import { fail, s } from "@feltdb/feltkit";
import { app, comments, profiles, reactions } from "./app.js";
import { CommentView, commentView, myProfile, record, requireProfile, requireVisiblePost } from "./_frame.js";
import { addComment } from "./_social.js";

const authorOwns = { collection: comments, id: "id", field: "authorId", via: { collection: profiles, field: "userId" } } as const;

export const create = app.mutation({
  access: "frame.write",
  args: { postId: s.string(), text: s.string({ minLength: 1, maxLength: 1000 }), parentId: s.optional(s.string()) },
  returns: s.string(),
  capability: { name: "comments.create", description: "Comment on a post the caller can see, or reply to a comment on it (parentId). @username mentions notify; mentioning @scout asks Scout to join." },
  handler: async (ctx, { postId, text, parentId }) => {
    const me = await requireProfile(ctx);
    const post = await requireVisiblePost(ctx.db, postId, me);
    return addComment(ctx, me, post, { text, ...(parentId ? { parentId } : {}) });
  },
});

export const update = app.mutation({
  access: "frame.write",
  args: { id: s.string(), text: s.string({ minLength: 1, maxLength: 1000 }) },
  returns: s.object({ id: s.string() }),
  owner: authorOwns,
  capability: { name: "comments.update", description: "Edit the text of one of the caller's own comments." },
  handler: async (ctx, { id, text }) => {
    const c = (await ctx.db.get(comments, id))!;
    if (c.deletedAt) fail("NOT_FOUND", "That comment does not exist.");
    if (!text.trim()) fail("INVALID_ARGUMENT", "A comment needs some text.");
    await ctx.db.patch(comments, id, { text: text.trim(), editedAt: Date.now() });
    return { id };
  },
});

export const remove = app.mutation({
  access: "frame.write",
  args: { id: s.string() },
  returns: s.object({ id: s.string(), tombstone: s.boolean() }),
  owner: authorOwns,
  capability: { name: "comments.delete", description: "Delete one of the caller's own comments (replies to it stay)." },
  handler: async (ctx, { id }) => {
    const c = (await ctx.db.get(comments, id))!;
    for (const r of await ctx.db.find(reactions, { target: `comment:${id}` })) await ctx.db.delete(reactions, r.id);
    const replies = await ctx.db.count(comments, { parentId: id });
    if (replies) await ctx.db.patch(comments, id, { text: "", deletedAt: Date.now() });
    else {
      await ctx.db.delete(comments, id);
      // A tombstone whose last reply just went is removed too, up the thread.
      let parentId = c.parentId;
      while (parentId) {
        const parent = await ctx.db.get(comments, parentId);
        if (!parent?.deletedAt || (await ctx.db.find(comments, { parentId })).some((x) => x.id !== id)) break;
        await ctx.db.delete(comments, parentId);
        parentId = parent.parentId;
      }
    }
    const me = (await myProfile(ctx))!;
    await record(ctx, me, "comment.deleted", { postId: c.postId, commentId: id });
    return { id, tombstone: replies > 0 };
  },
});

/**
 * A post's conversation, a page at a time: top-level comments oldest first (through the
 * (postId, root, createdAt) index), each with its whole reply thread. `cursor` is opaque.
 */
export const thread = app.query({
  access: "frame.read",
  args: { postId: s.string(), cursor: s.optional(s.string({ maxLength: 80 })), limit: s.optional(s.integer({ minimum: 1, maximum: 50 })) },
  returns: s.object({ comments: s.array(CommentView), nextCursor: s.nullable(s.string()), total: s.integer() }),
  capability: { name: "comments.thread", description: "The conversation on a post, paged by top-level comment (oldest first), each with all its replies (parentId). Pass nextCursor back as cursor for more." },
  handler: async (ctx, { postId, cursor, limit = 20 }) => {
    const me = await myProfile(ctx);
    await requireVisiblePost(ctx.db, postId, me);
    // Cursor: "<createdAt>:<id>" of the last root shown. Equal timestamps are ordered by id.
    const [at, lastId] = cursor ? [Number(cursor.split(":")[0]), cursor.split(":").slice(1).join(":")] : [undefined, ""];
    if (cursor && !Number.isFinite(at)) fail("INVALID_ARGUMENT", "Bad cursor.");
    const where = [{ field: "postId", eq: postId }, { field: "root", eq: true }, ...(at !== undefined ? [{ field: "createdAt", gte: at }] : [])];
    const byOrder = (a: { createdAt: number; id: string }, b: { createdAt: number; id: string }) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const roots: Array<Awaited<ReturnType<typeof ctx.db.get<typeof comments>>> & {}> = [];
    let pageCursor: string | undefined;
    // Read until there are more than `limit` roots and every root sharing the boundary timestamp has
    // been read (the index orders by time only; ties are ordered by id here), so nothing is skipped.
    for (let round = 0; round < 20; round++) {
      const { records, nextCursor, exhausted } = await ctx.db.query(comments, { where, orderBy: [{ field: "createdAt", direction: "asc" }], limit: limit + 1, ...(pageCursor ? { cursor: pageCursor } : {}) });
      for (const c of records) if (at === undefined || c.createdAt > at || c.id > lastId) roots.push(c);
      if (exhausted || !nextCursor || records.length === 0) break;
      roots.sort(byOrder);
      const boundary = roots[limit - 1]?.createdAt;
      if (roots.length > limit && records[records.length - 1]!.createdAt > boundary!) break;
      pageCursor = nextCursor;
    }
    roots.sort(byOrder);
    const shown = roots.slice(0, limit);
    // Each root's replies, breadth first through the parentId index (bounded).
    const out = [...shown];
    for (let i = 0; i < out.length && out.length < 500; i++) {
      const replies = await ctx.db.find(comments, { parentId: out[i]!.id }, { orderBy: [{ field: "createdAt", direction: "asc" }], limit: 200 });
      out.push(...replies);
    }
    const last = shown[shown.length - 1];
    return {
      comments: await Promise.all(out.map((c) => commentView(ctx.db, c, me?.id ?? null))),
      nextCursor: roots.length > limit && last ? `${last.createdAt}:${last.id}` : null,
      total: await ctx.db.count(comments, { postId }),
    };
  },
});
