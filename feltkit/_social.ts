/**
 * The interactions themselves, written once. A person in the browser, an external agent over MCP and
 * a resident agent (`app.agent`) all end up here, so there is one implementation of each rule: who may
 * see the post, what is unique, who is notified, what is recorded. `actor` is always the verified
 * caller's profile, or (delegated work) the person AuthBoundry just allowed the agent to act for, with
 * `via` naming that agent.
 */
import { fail, type MutationCtx } from "@feltdb/feltkit";
import { RESIDENTS, comments, media, memberships, postTopics, posts, profiles, reactions, tasks } from "./app.js";
import { canSee, mentionsIn, notify, record, topicsIn, type CommentDoc, type PostDoc, type ProfileDoc, type ReactionKind } from "./_frame.js";

export const EMOJI: Record<ReactionKind, string> = { like: "❤️", celebrate: "🎉", insightful: "💡", funny: "😄", wow: "😮", support: "🙏" };

const name = (p: ProfileDoc, via?: ProfileDoc) => (via ? `${p.username} (via ${via.displayName})` : p.username);

/**
 * Mentions in `text`: each mentioned participant who can see the post is notified; mentioning a
 * resident agent asks it to act (after commit, as itself).
 */
async function mentions(ctx: MutationCtx, actor: ProfileDoc, post: PostDoc, text: string, at: { commentId?: string }, via?: ProfileDoc) {
  for (const username of mentionsIn(text)) {
    const [them] = await ctx.db.find(profiles, { username });
    if (!them || them.id === actor.id || !(await canSee(ctx.db, post, them))) continue;
    if (them.id === RESIDENTS.scout.profileId && !actor.resident) {
      ctx.afterCommit.agent("scout", { postId: post.id, ...(at.commentId ? { commentId: at.commentId } : {}), askedBy: actor.id });
      continue;
    }
    // A resident agent's reply names people for display; it does not page them.
    if (actor.resident) continue;
    await notify(ctx, {
      recipient: them, actor, type: "mentioned", viaAgentId: via?.id,
      title: `${name(actor, via)} mentioned you.`,
      key: `mention:${at.commentId ?? post.id}:${them.id}`,
      data: { postId: post.id, commentId: at.commentId },
    });
  }
}

export async function publish(
  ctx: MutationCtx,
  actor: ProfileDoc,
  input: { text: string; visibility: "public" | "followers"; media: Array<{ fileId: string; width: number; height: number }>; communityId?: string },
  via?: ProfileDoc,
) {
  // Posting into a community needs membership in it (the author's, also when an agent posts for them).
  if (input.communityId && !(await ctx.db.find(memberships, { communityId: input.communityId, profileId: actor.id })).length) {
    fail("FORBIDDEN", "Join the community to post in it.");
  }
  const text = input.text.trim();
  if (!text && input.media.length === 0) fail("INVALID_ARGUMENT", "A post needs a photo or some text.");
  const now = Date.now();
  const topics = topicsIn(text);
  const id = await ctx.db.insert(posts, { authorId: actor.id, text, visibility: input.visibility, topics, createdAt: now, ...(via ? { viaAgentId: via.id } : {}), ...(input.communityId ? { communityId: input.communityId } : {}) });
  // media.fileId is unique: an upload is published at most once (FeltDB refuses a second time).
  for (const [position, m] of input.media.entries()) await ctx.db.insert(media, { postId: id, fileId: m.fileId, width: m.width, height: m.height, position });
  for (const topic of topics) await ctx.db.insert(postTopics, { postId: id, topic, createdAt: now });
  const post = (await ctx.db.get(posts, id))!;
  await mentions(ctx, actor, post, text, {}, via);
  await record(ctx, via ?? actor, "post.created", { postId: id, visibility: input.visibility, images: input.media.length, communityId: input.communityId }, via ? actor : undefined);
  return id;
}

export async function retopic(ctx: MutationCtx, post: PostDoc, text: string) {
  for (const t of await ctx.db.find(postTopics, { postId: post.id })) await ctx.db.delete(postTopics, t.id);
  const topics = topicsIn(text);
  for (const topic of topics) await ctx.db.insert(postTopics, { postId: post.id, topic, createdAt: post.createdAt });
  return topics;
}

export async function addComment(ctx: MutationCtx, actor: ProfileDoc, post: PostDoc, input: { text: string; parentId?: string }, via?: ProfileDoc) {
  const text = input.text.trim();
  if (!text) fail("INVALID_ARGUMENT", "A comment needs some text.");
  let parent: CommentDoc | null = null;
  if (input.parentId) {
    parent = await ctx.db.get(comments, input.parentId);
    if (!parent || parent.postId !== post.id || parent.deletedAt) fail("NOT_FOUND", "That comment does not exist.");
  }
  const id = await ctx.db.insert(comments, { postId: post.id, authorId: actor.id, text, root: !parent, createdAt: Date.now(), ...(parent ? { parentId: parent.id } : {}), ...(via ? { viaAgentId: via.id } : {}) });
  const postAuthor = (await ctx.db.get(profiles, post.authorId))!;
  const parentAuthor = parent ? await ctx.db.get(profiles, parent.authorId) : null;
  if (parentAuthor && parentAuthor.id !== actor.id) {
    await notify(ctx, { recipient: parentAuthor, actor, type: "comment.replied", viaAgentId: via?.id, title: `${name(actor, via)} replied to your comment.`, key: `reply:${id}`, data: { postId: post.id, commentId: id } });
  }
  if (postAuthor.id !== parentAuthor?.id) {
    await notify(ctx, { recipient: postAuthor, actor, type: "post.commented", viaAgentId: via?.id, title: `${name(actor, via)} commented on your post.`, key: `comment:${id}`, data: { postId: post.id, commentId: id } });
  }
  await mentions(ctx, actor, post, text, { commentId: id }, via);
  // Standing delegated work: Concierge thanks people who comment on its person's posts.
  if (postAuthor.id !== actor.id && !via && !actor.resident) {
    for (const task of await ctx.db.find(tasks, { ownerId: postAuthor.id, kind: "react", status: "active" })) ctx.afterCommit.agent("concierge", { taskId: task.id, commentId: id });
  }
  await record(ctx, via ?? actor, parent ? "comment.replied" : "comment.created", { postId: post.id, commentId: id, parentId: parent?.id }, via ? actor : undefined);
  return id;
}

/**
 * Set `actor`'s reaction on a post or a comment: add it, change it, or (same kind again) leave it.
 * `(target, profileId)` is unique, so two concurrent first reactions cannot both commit, and the
 * read below makes a repeat a no-op instead of a CONFLICT.
 */
export async function react(ctx: MutationCtx, actor: ProfileDoc, post: PostDoc, comment: CommentDoc | null, kind: ReactionKind, via?: ProfileDoc) {
  const target = comment ? `comment:${comment.id}` : `post:${post.id}`;
  const [existing] = await ctx.db.find(reactions, { target, profileId: actor.id });
  if (existing?.kind === kind) return { changed: false };
  if (existing) await ctx.db.patch(reactions, existing.id, { kind, ...(via ? { viaAgentId: via.id } : {}) });
  else await ctx.db.insert(reactions, { postId: post.id, target, profileId: actor.id, kind, createdAt: Date.now(), ...(comment ? { commentId: comment.id } : {}), ...(via ? { viaAgentId: via.id } : {}) });
  const recipient = (await ctx.db.get(profiles, comment ? comment.authorId : post.authorId))!;
  // Keyed by the reaction and its kind: changing it notifies once per kind, repeating it never.
  await notify(ctx, {
    recipient, actor, viaAgentId: via?.id,
    type: comment ? "comment.reacted" : "post.reacted",
    title: `${name(actor, via)} reacted ${EMOJI[kind]} to your ${comment ? "comment" : "post"}.`,
    key: `react:${target}:${actor.id}:${kind}`,
    data: { postId: post.id, commentId: comment?.id, reaction: kind },
  });
  await record(ctx, via ?? actor, "reaction.set", { postId: post.id, commentId: comment?.id, reaction: kind }, via ? actor : undefined);
  return { changed: true };
}
