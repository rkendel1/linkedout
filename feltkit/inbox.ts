/**
 * The caller's notifications, kept by AppPort Services Notifications (durable records; each principal
 * reads and marks only its own — the service enforces it). A notification holds ids, not content: the
 * snippet, the actor and the deep link are resolved here, at read time, under the reader's current
 * visibility, so deleting a post or hiding it from followers also hides it from old notifications.
 *
 * Paging is AppPort Services' own (`notifications.page`: newest first, an opaque cursor, a bounded
 * read through the per-recipient index). Frame groups within a page and filters "mentions" and
 * "agents" over the service's pages.
 */
import { s, type QueryCtx } from "@feltdb/feltkit";
import { NOTIFICATION_TYPES, app, comments, notificationSettings, posts, sponsorships, tasks } from "./app.js";
import { Author, authorById, canSee, myProfile, requireProfile } from "./_frame.js";

const Filter = s.enum(["all", "unread", "mentions", "agents"]);
const Type = s.enum(NOTIFICATION_TYPES);

const Group = s.object({
  /** Every notification id in the group (mark them read together). */
  ids: s.array(s.string()),
  type: s.string(),
  title: s.string(),
  read: s.boolean(),
  createdAt: s.string(),
  actors: s.array(Author),
  /** More actors than are listed. */
  count: s.integer(),
  /** The agent that acted on the actor's behalf, if one did. */
  via: s.nullable(Author),
  fromAgent: s.boolean(),
  reaction: s.nullable(s.string()),
  /** Where it leads. Null post when the post is gone or the reader may no longer see it. */
  link: s.object({ postId: s.nullable(s.string()), commentId: s.nullable(s.string()), taskId: s.nullable(s.string()), profileUsername: s.nullable(s.string()), sponsorshipId: s.nullable(s.string()) }),
  snippet: s.nullable(s.string()),
  /** The thing it referred to no longer exists or is hidden from the reader. */
  unavailable: s.boolean(),
  /** For a sponsorship request: still waiting for an answer. */
  actionable: s.boolean(),
});

const str = (v: unknown) => (typeof v === "string" ? v : null);
const GROUPABLE = new Set(["post.reacted", "comment.reacted", "user.followed"]);

async function resolve(ctx: QueryCtx, n: { id: string; type: string; title: string; createdAt: string; readAt?: string; data?: Record<string, unknown> }, me: Awaited<ReturnType<typeof myProfile>>) {
  const d = n.data ?? {};
  const [actor, via] = await Promise.all([authorById(ctx.db, str(d.actorId) ?? undefined), authorById(ctx.db, str(d.viaAgentId) ?? undefined)]);
  let postId = str(d.postId);
  let commentId = str(d.commentId);
  let snippet: string | null = null;
  let unavailable = false;
  if (postId) {
    const post = await ctx.db.get(posts, postId);
    if (!post || !(await canSee(ctx.db, post, me))) {
      unavailable = true;
      postId = null;
      commentId = null;
    } else {
      const c = commentId ? await ctx.db.get(comments, commentId) : null;
      if (commentId && (!c || c.deletedAt)) commentId = null;
      snippet = (c && !c.deletedAt ? c.text : post.text).slice(0, 120) || null;
    }
  }
  const taskId = str(d.taskId);
  if (taskId) {
    const t = await ctx.db.get(tasks, taskId);
    snippet = t?.summary ?? t?.error ?? snippet;
    if (t?.resultPostId && (await ctx.db.get(posts, t.resultPostId))) postId = t.resultPostId;
  }
  const sponsorshipId = str(d.sponsorshipId);
  const actionable = sponsorshipId ? (await ctx.db.get(sponsorships, sponsorshipId))?.status === "pending" : false;
  return {
    n, actor, via, snippet, unavailable, actionable, reaction: str(d.reaction),
    fromAgent: d.actorKind === "agent" || Boolean(d.viaAgentId),
    link: { postId, commentId, taskId, sponsorshipId, profileUsername: actor?.username ?? null },
  };
}

const MENTIONS = new Set(["mentioned", "comment.replied"]);
const fromAgent = (n: { type: string; data?: Record<string, unknown> }) => n.data?.actorKind === "agent" || Boolean(n.data?.viaAgentId) || n.type.startsWith("agent.");

export const list = app.query({
  access: "notifications.read",
  args: { filter: s.optional(Filter), cursor: s.optional(s.string()), limit: s.optional(s.integer({ minimum: 1, maximum: 50 })) },
  returns: s.object({ groups: s.array(Group), nextCursor: s.nullable(s.string()), unread: s.integer(), unreadComplete: s.boolean() }),
  capability: { name: "notifications.inbox", description: "The caller's notifications, newest first, grouped (several reactions to one post become one entry), with deep links. filter: all, unread, mentions, agents. Pass nextCursor back as cursor, with the same filter and limit." },
  handler: async (ctx, { filter = "all", cursor, limit = 20 }) => {
    const me = await myProfile(ctx);
    const service = ctx.services.notifications;
    // The service's cursor is bound to its filters and limit: every page of one walk asks the same.
    const keep = filter === "mentions" ? (n: { type: string }) => MENTIONS.has(n.type) : filter === "agents" ? fromAgent : () => true;
    const items: Awaited<ReturnType<typeof service.page>>["items"] = [];
    let next: string | undefined = cursor;
    for (let round = 0; round < 10; round++) {
      const page = await service.page({ limit, ...(filter === "unread" ? { unread: true } : {}), ...(next ? { cursor: next } : {}) });
      items.push(...page.items.filter(keep));
      next = page.nextCursor;
      if (!next || items.length >= limit) break;
    }
    const groups: Array<Awaited<ReturnType<typeof resolve>> & { ids: string[]; actors: NonNullable<Awaited<ReturnType<typeof resolve>>["actor"]>[]; read: boolean }> = [];
    for (const n of items) {
      const r = await resolve(ctx, n, me);
      const last = groups[groups.length - 1];
      const same = last && GROUPABLE.has(n.type) && last.n.type === n.type && last.link.postId === r.link.postId && last.link.commentId === r.link.commentId && !r.unavailable && !last.unavailable;
      if (same) {
        last.ids.push(n.id);
        if (r.actor && !last.actors.some((a) => a.id === r.actor!.id)) last.actors.push(r.actor);
        last.read = last.read && Boolean(n.readAt);
      } else groups.push({ ...r, ids: [n.id], actors: r.actor ? [r.actor] : [], read: Boolean(n.readAt) });
    }
    const unread = await service.unreadCount({ max: 99 });
    return {
      unread: unread.count,
      unreadComplete: unread.complete,
      nextCursor: next ?? null,
      groups: groups.map((g) => ({
        ids: g.ids, type: g.n.type, title: g.n.title, read: g.read, createdAt: g.n.createdAt,
        actors: g.actors.slice(0, 3), count: g.actors.length, via: g.via, fromAgent: g.fromAgent, reaction: g.reaction,
        link: g.link, snippet: g.snippet, unavailable: g.unavailable, actionable: g.actionable,
      })),
    };
  },
});

/** Unread notifications, counted up to 99 ("99+" when `complete` is false). */
export const unreadCount = app.query({
  access: "notifications.read",
  returns: s.object({ count: s.integer(), complete: s.boolean() }),
  handler: async (ctx) => ctx.services.notifications.unreadCount({ max: 99 }),
});

export const markRead = app.mutation({
  access: "notifications.update",
  args: { ids: s.array(s.string(), { minItems: 1, maxItems: 100 }) },
  returns: s.integer(),
  capability: { name: "notifications.markread", description: "Mark some of the caller's notifications read (by id)." },
  // The service refuses anyone else's notification: a principal marks only its own.
  handler: async (ctx, { ids }) => {
    for (const id of ids) await ctx.services.notifications.markRead(id);
    return ids.length;
  },
});

export const markAllRead = app.mutation({
  access: "notifications.update",
  returns: s.integer(),
  capability: { name: "notifications.markallread", description: "Mark all of the caller's notifications read." },
  handler: async (ctx) => {
    let marked = 0;
    // The service marks at most 1,000 a call and says when it is done.
    for (let round = 0; round < 20; round++) {
      const r = await (ctx.services.notifications as import("@feltdb/feltkit").NotificationsWriter).markAllRead({});
      marked += r.marked;
      if (r.complete) break;
    }
    return marked;
  },
});

const Settings = s.object({ muted: s.array(Type), fromAgents: s.boolean() });

export const settings = app.query({
  access: "frame.read",
  returns: Settings,
  capability: { name: "notifications.settings", description: "Which notifications the caller receives." },
  handler: async (ctx) => {
    const me = await myProfile(ctx);
    const [row] = me ? await ctx.db.find(notificationSettings, { profileId: me.id }) : [];
    return { muted: row?.muted ?? [], fromAgents: row?.fromAgents ?? true };
  },
});

export const updateSettings = app.mutation({
  access: "frame.write",
  args: { muted: s.optional(s.array(Type)), fromAgents: s.optional(s.boolean()) },
  returns: Settings,
  capability: { name: "notifications.updatesettings", description: "Mute notification types, or everything caused by agents (your own delegated tasks still report)." },
  handler: async (ctx, { muted, fromAgents }) => {
    const me = await requireProfile(ctx);
    const [row] = await ctx.db.find(notificationSettings, { profileId: me.id });
    const next = { muted: [...new Set(muted ?? row?.muted ?? [])], fromAgents: fromAgents ?? row?.fromAgents ?? true };
    if (row) await ctx.db.patch(notificationSettings, row.id, next);
    else await ctx.db.insert(notificationSettings, { profileId: me.id, ...next });
    return next;
  },
});
