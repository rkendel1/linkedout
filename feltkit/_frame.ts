/**
 * Shared rules for Frame's functions: who the caller is, who may see what, the shapes Frame
 * publishes, and the two side effects every interaction has (a notification, an activity record).
 * Not a function module (the leading underscore).
 */
import { fail, s, type DatabaseReader, type Doc, type MutationCtx, type QueryCtx } from "@feltdb/feltkit";
import { REACTIONS, activity, comments, communities, follows, media, notificationSettings, posts, profiles, reactions, type NOTIFICATION_TYPES } from "./app.js";

export type ProfileDoc = Doc<typeof profiles.shape>;
export type PostDoc = Doc<typeof posts.shape>;
export type CommentDoc = Doc<typeof comments.shape>;
export type ReactionKind = (typeof REACTIONS)[number];
type NotificationType = (typeof NOTIFICATION_TYPES)[number];

// ---------------------------------------------------------------------------------------------- who

/** The caller's profile, or null before they have chosen a username. */
export async function myProfile(ctx: { db: DatabaseReader; auth: QueryCtx["auth"] }): Promise<ProfileDoc | null> {
  const principal = ctx.auth.principal;
  if (!principal) return null;
  const [me] = await ctx.db.find(profiles, { userId: principal.id });
  return me ?? null;
}

/** The caller's profile; refuses callers who have not created one yet. */
export async function requireProfile(ctx: { db: DatabaseReader; auth: QueryCtx["auth"] }): Promise<ProfileDoc> {
  return (await myProfile(ctx)) ?? fail("FAILED_PRECONDITION", "Create your Frame profile first.");
}

/** A person (not an agent). Delegation and sponsorship are a person's decisions. */
export async function requirePerson(ctx: { db: DatabaseReader; auth: QueryCtx["auth"] }): Promise<ProfileDoc> {
  const me = await requireProfile(ctx);
  if (me.kind !== "person" || ctx.auth.requirePrincipal().type === "agent") fail("FORBIDDEN", "Only a person can do this.");
  return me;
}

// --------------------------------------------------------------------------------------- visibility

/** Whether `viewer` may see `post`: public, their own, or followers-only and they follow the author. */
export async function canSee(db: DatabaseReader, post: PostDoc, viewer: ProfileDoc | null): Promise<boolean> {
  if (post.visibility === "public") return true;
  if (!viewer) return false;
  if (post.authorId === viewer.id) return true;
  return (await db.find(follows, { followerId: viewer.id, followeeId: post.authorId })).length > 0;
}

/** The post, if it exists and the viewer may see it. Unknown and hidden are the same answer. */
export async function visiblePost(db: DatabaseReader, postId: string, viewer: ProfileDoc | null): Promise<PostDoc | null> {
  const post = await db.get(posts, postId);
  return post && (await canSee(db, post, viewer)) ? post : null;
}

export async function requireVisiblePost(db: DatabaseReader, postId: string, viewer: ProfileDoc | null): Promise<PostDoc> {
  return (await visiblePost(db, postId, viewer)) ?? fail("NOT_FOUND", "That post does not exist.");
}

// -------------------------------------------------------------------------------------------- shapes

export const Author = s.object({
  id: s.string(),
  username: s.string(),
  displayName: s.string(),
  avatarFileId: s.optional(s.string()),
  kind: s.enum(["person", "agent"]),
  /** An agent with a responsible person, or one of Frame's own. */
  verified: s.boolean(),
});

export function author(p: ProfileDoc) {
  return {
    id: p.id, username: p.username, displayName: p.displayName, kind: p.kind,
    verified: p.kind === "agent" && Boolean(p.resident || p.ownerId),
    ...(p.avatarFileId ? { avatarFileId: p.avatarFileId } : {}),
  };
}

export async function authorById(db: DatabaseReader, id: string | undefined) {
  if (!id) return null;
  const p = await db.get(profiles, id);
  return p ? author(p) : null;
}

export const ReactionSummary = s.object({
  counts: s.record(s.integer()),
  total: s.integer(),
  /** The caller's reaction, if any. */
  mine: s.nullable(s.enum(REACTIONS)),
});

export async function reactionSummary(db: DatabaseReader, target: string, meId: string | null) {
  const all = await db.find(reactions, { target });
  const counts: Record<string, number> = {};
  let mine: ReactionKind | null = null;
  for (const r of all) {
    counts[r.kind] = (counts[r.kind] ?? 0) + 1;
    if (r.profileId === meId) mine = r.kind;
  }
  return { counts, total: all.length, mine };
}

export const Media = s.object({ fileId: s.string(), width: s.integer(), height: s.integer() });

export const CommentView = s.object({
  id: s.string(),
  postId: s.string(),
  parentId: s.nullable(s.string()),
  text: s.string(),
  createdAt: s.number(),
  editedAt: s.nullable(s.number()),
  deleted: s.boolean(),
  author: s.nullable(Author),
  via: s.nullable(Author),
  reactions: ReactionSummary,
  replyCount: s.integer(),
  mine: s.boolean(),
});

export async function commentView(db: DatabaseReader, c: CommentDoc, meId: string | null) {
  const deleted = Boolean(c.deletedAt);
  const [a, via, summary, replyCount] = await Promise.all([
    deleted ? null : authorById(db, c.authorId),
    deleted ? null : authorById(db, c.viaAgentId),
    reactionSummary(db, `comment:${c.id}`, meId),
    db.count(comments, { parentId: c.id }),
  ]);
  return {
    id: c.id, postId: c.postId, parentId: c.parentId ?? null, text: deleted ? "" : c.text, createdAt: c.createdAt,
    editedAt: c.editedAt ?? null, deleted, author: a, via, reactions: summary, replyCount, mine: !deleted && c.authorId === meId,
  };
}

export const PostCard = s.object({
  id: s.string(),
  text: s.string(),
  visibility: s.enum(["public", "followers"]),
  topics: s.array(s.string()),
  media: s.array(Media),
  createdAt: s.number(),
  editedAt: s.nullable(s.number()),
  author: Author,
  community: s.nullable(s.object({ slug: s.string(), name: s.string() })),
  /** The agent that published it on the author's behalf. */
  via: s.nullable(Author),
  reactions: ReactionSummary,
  commentCount: s.integer(),
  mine: s.boolean(),
  /** The latest top-level comments (feed preview). */
  comments: s.array(CommentView),
});
export const FeedPage = s.object({ posts: s.array(PostCard), nextCursor: s.nullable(s.number()) });

export async function postMedia(db: DatabaseReader, postId: string) {
  const list = await db.find(media, { postId }, { orderBy: [{ field: "position", direction: "asc" }] });
  return list.map((m) => ({ fileId: m.fileId, width: m.width, height: m.height }));
}

/** Posts as the feed shows them. The caller must already have checked visibility. */
export function cards(db: DatabaseReader, list: PostDoc[], meId: string | null, commentLimit = 2) {
  return Promise.all(
    list.map(async (p) => {
      const [a, via, summary, all, images, community] = await Promise.all([
        db.get(profiles, p.authorId),
        authorById(db, p.viaAgentId),
        reactionSummary(db, `post:${p.id}`, meId),
        db.find(comments, { postId: p.id }),
        postMedia(db, p.id),
        p.communityId ? db.get(communities, p.communityId) : null,
      ]);
      const live = all.filter((c) => !c.deletedAt);
      const recent = commentLimit ? live.filter((c) => !c.parentId).sort((x, y) => y.createdAt - x.createdAt).slice(0, commentLimit).reverse() : [];
      return {
        id: p.id, text: p.text, visibility: p.visibility, topics: p.topics, media: images, createdAt: p.createdAt, editedAt: p.editedAt ?? null,
        author: author(a!), community: community ? { slug: community.slug, name: community.name } : null, via, reactions: summary, commentCount: live.length, mine: p.authorId === meId,
        comments: await Promise.all(recent.map((c) => commentView(db, c, meId))),
      };
    }),
  );
}

export const GridItem = s.object({ id: s.string(), text: s.string(), cover: s.nullable(Media), mediaCount: s.integer(), createdAt: s.number(), reactionCount: s.integer(), commentCount: s.integer(), author: Author });
export const GridPage = s.object({ posts: s.array(GridItem), nextCursor: s.nullable(s.number()) });

export function gridItems(db: DatabaseReader, list: PostDoc[]) {
  return Promise.all(
    list.map(async (p) => {
      const [images, reactionCount, commentCount, a] = await Promise.all([postMedia(db, p.id), db.count(reactions, { target: `post:${p.id}` }), db.count(comments, { postId: p.id }), db.get(profiles, p.authorId)]);
      return { id: p.id, text: p.text, cover: images[0] ?? null, mediaCount: images.length, createdAt: p.createdAt, reactionCount, commentCount, author: author(a!) };
    }),
  );
}

/**
 * One page of visible posts newest-first, `before` a createdAt cursor: from a set of authors, a set of
 * communities, or everyone's public posts. A set is one FeltDB query (`in`), which FeltDB serves as a
 * merge of the ordered (authorId|communityId, createdAt desc) index ranges: a page reads about `limit`
 * records however many authors there are. Reads past hidden posts (bounded) so a page is not short.
 */
export async function page(db: DatabaseReader, viewer: ProfileDoc | null, opts: { authorIds?: string[]; communityIds?: string[]; before?: number; limit: number }) {
  const out: PostDoc[] = [];
  let before = opts.before;
  const scope = opts.authorIds ? { field: "authorId", in: opts.authorIds } : opts.communityIds ? { field: "communityId", in: opts.communityIds } : { field: "visibility", eq: "public" };
  if ((opts.authorIds ?? opts.communityIds)?.length === 0) return { items: [], nextCursor: null };
  for (let round = 0; round < 5 && out.length <= opts.limit; round++) {
    const where = [scope, ...(before !== undefined ? [{ field: "createdAt", lt: before }] : [])];
    const { records } = await db.query(posts, { where, orderBy: [{ field: "createdAt", direction: "desc" }], limit: opts.limit + 1 });
    for (const p of records) if (await canSee(db, p, viewer)) out.push(p);
    if (records.length <= opts.limit) break;
    before = records[records.length - 1]!.createdAt;
  }
  const items = out.slice(0, opts.limit);
  return { items, nextCursor: out.length > opts.limit ? items[items.length - 1]!.createdAt : null };
}

// ------------------------------------------------------------------------------------------- text

/** A mention never ends with ".": "@sol.reyes." at the end of a sentence names sol.reyes. */
const MENTION = /@([a-z0-9._]{2,29}[a-z0-9_])/g;
const TOPIC = /#([\p{L}\p{N}_]{2,40})/gu;
export const topicsIn = (text: string) => [...new Set([...text.matchAll(TOPIC)].map((m) => m[1]!.toLowerCase()))].slice(0, 10);
export const mentionsIn = (text: string) => [...new Set([...text.matchAll(MENTION)].map((m) => m[1]!))].slice(0, 10);

// ------------------------------------------------------------------------------------------ uploads

/** The image type the bytes actually are (JPEG, PNG, WebP, GIF), whatever the uploader claimed. */
export function imageType(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

/** An upload the caller made for `purpose`, whose bytes are an image; refuses anything else. */
export async function ownImage(ctx: { services: { files: import("@feltdb/feltkit").FilesReader } }, fileId: string, ownerId: string, purpose: "post" | "avatar") {
  const read = await ctx.services.files.read(fileId).catch(() => null);
  if (!read || read.file.owner !== ownerId || read.file.metadata.purpose !== purpose) fail("FORBIDDEN", "That upload is not yours.");
  if (!imageType(read!.bytes)) fail("INVALID_ARGUMENT", "Only JPEG, PNG, WebP or GIF images can be used.");
  return read!.file;
}

// -------------------------------------------------------------------------------- notifications

/**
 * Notify `recipient` about something `actor` did, if it commits, unless they muted it. Notifications
 * carry ids, never content: what a notification shows is read when it is listed, under the reader's
 * visibility, so a deleted or hidden post never leaks through an old notification.
 */
export async function notify(
  ctx: Pick<MutationCtx, "db" | "afterCommit">,
  input: { recipient: ProfileDoc; actor: ProfileDoc; type: NotificationType; title: string; key: string; viaAgentId?: string; data?: Record<string, string | undefined> },
) {
  const { recipient, actor } = input;
  if (recipient.id === actor.id || recipient.resident) return;
  const fromAgent = actor.kind === "agent" || Boolean(input.viaAgentId);
  const ownTask = input.type.startsWith("agent.task_") || input.type === "agent.permission_needed";
  const [settings] = await ctx.db.find(notificationSettings, { profileId: recipient.id });
  if (settings?.muted.includes(input.type)) return;
  if (settings && !settings.fromAgents && fromAgent && !ownTask) return;
  const data: Record<string, string> = { actorId: actor.id, actorKind: actor.kind };
  if (input.viaAgentId) data.viaAgentId = input.viaAgentId;
  for (const [k, v] of Object.entries(input.data ?? {})) if (v !== undefined) data[k] = v;
  ctx.afterCommit.notifications.send({ recipient: recipient.userId, type: input.type, title: input.title, data, idempotencyKey: input.key });
}

// ------------------------------------------------------------------------------------------ activity

/**
 * Record what `actor` did (and, for delegated work, the same event on the person it was done for),
 * in this mutation's transaction. FeltKit adds the verified caller, its type and the request id.
 */
export async function record(ctx: MutationCtx, actor: { id: string }, type: string, data: Record<string, string | number | boolean | undefined> = {}, onBehalfOf?: { id: string }) {
  const clean = Object.fromEntries(Object.entries({ ...data, profileId: actor.id, ...(onBehalfOf ? { onBehalfOf: onBehalfOf.id } : {}) }).filter(([, v]) => v !== undefined));
  await activity.record(ctx, { subject: "profile", id: actor.id, type, data: clean });
  if (onBehalfOf && onBehalfOf.id !== actor.id) await activity.record(ctx, { subject: "profile", id: onBehalfOf.id, type, data: { ...clean, via: actor.id } });
}
