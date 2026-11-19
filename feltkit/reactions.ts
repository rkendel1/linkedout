/**
 * Reactions on posts and comments. One per participant per target (FeltDB's unique constraint);
 * setting the same reaction again changes nothing, setting another changes it, removing is idempotent.
 */
import { fail, s } from "@feltdb/feltkit";
import { REACTIONS, app, comments, profiles, reactions } from "./app.js";
import { Author, ReactionSummary, author, myProfile, reactionSummary, record, requireProfile, requireVisiblePost } from "./_frame.js";
import { react } from "./_social.js";

const Kind = s.enum(REACTIONS);
/** Counts as queries report them: kinds nobody holds are absent. */
const nonzero = (counts: Record<string, number>) => Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));

async function resolve(ctx: Parameters<typeof requireProfile>[0], postId: string, commentId?: string) {
  const me = await requireProfile(ctx);
  const post = await requireVisiblePost(ctx.db, postId, me);
  const comment = commentId ? await ctx.db.get(comments, commentId) : null;
  if (commentId && (!comment || comment.postId !== postId || comment.deletedAt)) fail("NOT_FOUND", "That comment does not exist.");
  return { me, post, comment, target: comment ? `comment:${comment.id}` : `post:${post.id}` };
}

export const set = app.mutation({
  access: "frame.write",
  args: { postId: s.string(), commentId: s.optional(s.string()), kind: Kind },
  returns: ReactionSummary,
  capability: { name: "reactions.set", description: `React to a post, or to a comment on it (commentId), as the caller: ${REACTIONS.join(", ")}. Replaces the caller's earlier reaction; repeating it changes nothing.` },
  handler: async (ctx, { postId, commentId, kind }) => {
    const { me, post, comment, target } = await resolve(ctx, postId, commentId);
    // The summary as committed state stands, then this call's own change applied to it.
    const before = await reactionSummary(ctx.db, target, me.id);
    await react(ctx, me, post, comment, kind);
    if (before.mine === kind) return before;
    const counts = { ...before.counts, [kind]: (before.counts[kind] ?? 0) + 1 };
    if (before.mine) counts[before.mine] = counts[before.mine]! - 1;
    return { counts: nonzero(counts), total: before.total + (before.mine ? 0 : 1), mine: kind };
  },
});

export const remove = app.mutation({
  access: "frame.write",
  args: { postId: s.string(), commentId: s.optional(s.string()) },
  returns: ReactionSummary,
  capability: { name: "reactions.remove", description: "Remove the caller's reaction from a post or a comment (idempotent)." },
  handler: async (ctx, { postId, commentId }) => {
    const { me, target } = await resolve(ctx, postId, commentId);
    const before = await reactionSummary(ctx.db, target, me.id);
    if (!before.mine) return before;
    for (const r of await ctx.db.find(reactions, { target, profileId: me.id })) await ctx.db.delete(reactions, r.id);
    await record(ctx, me, "reaction.removed", { postId, commentId });
    return { counts: nonzero({ ...before.counts, [before.mine]: before.counts[before.mine]! - 1 }), total: before.total - 1, mine: null };
  },
});

/** Who reacted, and how: only on posts the caller can see. */
export const list = app.query({
  access: "frame.read",
  args: { postId: s.string(), commentId: s.optional(s.string()) },
  returns: s.array(s.object({ kind: Kind, profile: Author, via: s.nullable(Author), createdAt: s.number() })),
  capability: { name: "reactions.list", description: "Who reacted to a post or comment the caller can see, and with which reaction (people and agents)." },
  handler: async (ctx, { postId, commentId }) => {
    await requireVisiblePost(ctx.db, postId, await myProfile(ctx));
    const all = await ctx.db.find(reactions, { target: commentId ? `comment:${commentId}` : `post:${postId}` });
    const out = [];
    for (const r of all.sort((a, b) => b.createdAt - a.createdAt)) {
      const p = await ctx.db.get(profiles, r.profileId);
      const via = r.viaAgentId ? await ctx.db.get(profiles, r.viaAgentId) : null;
      if (p) out.push({ kind: r.kind, profile: author(p), via: via ? author(via) : null, createdAt: r.createdAt });
    }
    return out;
  },
});
