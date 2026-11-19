/**
 * Delegation. A person grants Concierge, by name, capabilities (AuthBoundry grants to that agent, through
 * FeltKit's `ctx.authority.grants`), assigns it work (a `tasks` record), and Concierge does that work later, as
 * itself, on the person's behalf. Every time it is about to act, it asks AuthBoundry
 * (`ctx.authority.decide`, on behalf of that person): a revoked or expired grant stops the very next
 * action, and the task records why and asks the person. Frame never stores a grant: AuthBoundry is the
 * authority, and the `decisionId` / `delegationId` on each task and activity record are its evidence.
 */
import { fail, s } from "@feltdb/feltkit";
import { DELEGABLE, RESIDENTS, app, comments, posts, profiles, reactions, follows, tasks, type DelegableCapability } from "./app.js";
import { Author, PostCard, authorById, cards, myProfile, notify, ownImage, record, requirePerson } from "./_frame.js";
import { publish, react } from "./_social.js";

const CAPABILITY = { publish: "frame.publish", react: "frame.react", digest: "frame.digest" } as const satisfies Record<string, DelegableCapability>;
const ownerOwns = { collection: tasks, id: "id", field: "ownerId", via: { collection: profiles, field: "userId" } } as const;
const Cap = s.enum(Object.keys(DELEGABLE) as [DelegableCapability, ...DelegableCapability[]]);
/** The agent delegated work is granted to: Concierge's own AuthBoundry identity, never the application's. */
const CONCIERGE = RESIDENTS.concierge.principal;

// ---------------------------------------------------------------------------------- delegation

const Grant = s.object({ capability: Cap, description: s.string(), granted: s.boolean(), grantId: s.nullable(s.string()), expiresAt: s.nullable(s.number()) });

/**
 * What the caller allows Concierge to do, as AuthBoundry holds it right now. A mutation because it asks
 * AuthBoundry (an external decision service), which queries cannot.
 */
export const delegationStatus = app.mutation({
  access: "frame.delegate",
  returns: s.array(Grant),
  capability: { name: "delegation.status", description: "What the caller has allowed Concierge to do on their behalf, as AuthBoundry holds it now." },
  handler: async (ctx) => {
    await requirePerson(ctx);
    const grants = (await ctx.authority.grants.list()).filter((g) => g.agent === CONCIERGE && g.status === "active" && (g.expiresAt === null || g.expiresAt > Date.now()));
    return (Object.keys(DELEGABLE) as DelegableCapability[]).map((capability) => {
      const g = grants.find((x) => x.capabilities.includes(capability));
      return { capability, description: DELEGABLE[capability], granted: Boolean(g), grantId: g?.id ?? null, expiresAt: g?.expiresAt ?? null };
    });
  },
});

export const grant = app.mutation({
  access: "frame.delegate",
  args: { capability: Cap, expiresInHours: s.optional(s.integer({ minimum: 1, maximum: 24 * 365 })) },
  returns: s.object({ grantId: s.string() }),
  capability: { name: "delegation.grant", description: "Allow Concierge one capability on the caller's behalf (optionally for a limited time). Person only." },
  handler: async (ctx, { capability, expiresInHours }) => {
    const me = await requirePerson(ctx);
    const g = await ctx.authority.grants.grant({ capabilities: [capability], agent: CONCIERGE, ...(expiresInHours ? { expiresAt: Date.now() + expiresInHours * 3_600_000 } : {}) });
    await record(ctx, me, "delegation.granted", { capability, delegationId: g.id });
    return { grantId: g.id };
  },
});

export const revoke = app.mutation({
  access: "frame.delegate",
  args: { capability: Cap },
  returns: s.object({ revoked: s.integer() }),
  capability: { name: "delegation.revoke", description: "Withdraw a capability from Concierge. Its next attempt to use it is refused by AuthBoundry." },
  handler: async (ctx, { capability }) => {
    const me = await requirePerson(ctx);
    const grants = (await ctx.authority.grants.list()).filter((g) => g.agent === CONCIERGE && g.status === "active" && g.capabilities.includes(capability));
    for (const g of grants) {
      await ctx.authority.grants.revoke(g.id);
      // A grant that covered other capabilities is re-made without this one.
      const rest = g.capabilities.filter((c) => c !== capability);
      if (rest.length) await ctx.authority.grants.grant({ capabilities: rest, agent: CONCIERGE, ...(g.expiresAt ? { expiresAt: g.expiresAt } : {}) });
    }
    await record(ctx, me, "delegation.revoked", { capability });
    return { revoked: grants.length };
  },
});

// --------------------------------------------------------------------------------------- tasks

const TaskView = s.object({
  id: s.string(),
  kind: s.enum(["publish", "react", "digest"]),
  capability: Cap,
  status: s.string(),
  agent: Author,
  runAt: s.number(),
  runs: s.integer(),
  draft: s.nullable(s.object({ text: s.string(), visibility: s.string(), images: s.integer() })),
  result: s.nullable(PostCard),
  summary: s.nullable(s.string()),
  error: s.nullable(s.string()),
  decisionId: s.nullable(s.string()),
  delegationId: s.nullable(s.string()),
  createdAt: s.number(),
  updatedAt: s.number(),
});

export const create = app.mutation({
  access: "frame.delegate",
  args: {
    kind: s.enum(["publish", "react", "digest"]),
    draft: s.optional(s.object({ text: s.string({ maxLength: 2200 }), visibility: s.optional(s.enum(["public", "followers"])), media: s.optional(s.array(s.object({ fileId: s.string(), width: s.integer({ minimum: 1 }), height: s.integer({ minimum: 1 }) }), { maxItems: 10 })) })),
    runAt: s.optional(s.number()),
  },
  returns: s.string(),
  capability: { name: "tasks.create", description: "Delegate work to Concierge: publish a prepared post at runAt, thank (react to) new comments on your posts while active, or send you an activity digest. Person only; Concierge still needs the matching delegation grant when it acts." },
  handler: async (ctx, { kind, draft, runAt }) => {
    const me = await requirePerson(ctx);
    const now = Date.now();
    if (kind === "publish") {
      if (!draft) fail("INVALID_ARGUMENT", "A scheduled post needs a draft.");
      if (!draft!.text.trim() && !draft!.media?.length) fail("INVALID_ARGUMENT", "A post needs a photo or some text.");
      // Checked now, as the person: the images must be their own uploads. Concierge never reads files.
      for (const m of draft!.media ?? []) await ownImage(ctx, m.fileId, me.userId, "post");
    }
    if (kind === "react") {
      const [active] = await ctx.db.find(tasks, { ownerId: me.id, kind: "react", status: "active" });
      if (active) return active.id;
    }
    const due = Math.max(now, runAt ?? now);
    const id = await ctx.db.insert(tasks, {
      ownerId: me.id, agentId: RESIDENTS.concierge.profileId, kind, capability: CAPABILITY[kind],
      status: kind === "react" ? "active" : "scheduled", runAt: due, runs: 0, createdAt: now, updatedAt: now,
      ...(kind === "publish" ? { draft: { text: draft!.text.trim(), visibility: draft!.visibility ?? "public", media: draft!.media ?? [] } } : {}),
    });
    if (kind !== "react") {
      if (due <= now + 1000) ctx.afterCommit.agent("concierge", { taskId: id });
      else ctx.afterCommit.jobs.enqueue("task.due", { id }, { runAt: new Date(due).toISOString() });
    }
    await record(ctx, me, "task.created", { taskId: id, kind, capability: CAPABILITY[kind] });
    return id;
  },
});

/** Job "task.due": a scheduled task's time came; hand it to Concierge. Runs as the task's owner. */
export const due = app.mutation({
  access: "frame.delegate",
  args: { id: s.string() },
  returns: s.object({ started: s.boolean() }),
  owner: ownerOwns,
  handler: async (ctx, { id }) => {
    const t = (await ctx.db.get(tasks, id))!;
    if (t.status !== "scheduled") return { started: false };
    ctx.afterCommit.agent("concierge", { taskId: id });
    return { started: true };
  },
});

export const cancel = app.mutation({
  access: "frame.delegate",
  args: { id: s.string() },
  returns: s.object({ status: s.string() }),
  owner: ownerOwns,
  capability: { name: "tasks.cancel", description: "Cancel one of the caller's delegated tasks (a standing one stops)." },
  handler: async (ctx, { id }) => {
    const t = (await ctx.db.get(tasks, id))!;
    if (["completed", "cancelled"].includes(t.status)) return { status: t.status };
    await ctx.db.patch(tasks, id, { status: "cancelled", updatedAt: Date.now() });
    // The images uploaded for a scheduled post that will now never be published are released, after
    // this commits, by the same job that releases a deleted post's photos (it keeps any still in use).
    for (const m of t.draft?.media ?? []) ctx.afterCommit.jobs.enqueue("media.release", { fileId: m.fileId });
    await record(ctx, { id: t.ownerId }, "task.cancelled", { taskId: id });
    return { status: "cancelled" };
  },
});

/** After a task stopped for want of permission (or failed): run it again, e.g. once the grant is back. */
export const retry = app.mutation({
  access: "frame.delegate",
  args: { id: s.string() },
  returns: s.object({ status: s.string() }),
  owner: ownerOwns,
  capability: { name: "tasks.retry", description: "Run again one of the caller's tasks that stopped for want of permission or failed." },
  handler: async (ctx, { id }) => {
    const t = (await ctx.db.get(tasks, id))!;
    if (!["needs_permission", "failed"].includes(t.status)) fail("FAILED_PRECONDITION", `The task is ${t.status}.`);
    const status = t.kind === "react" ? "active" : "scheduled";
    await ctx.db.patch(tasks, id, { status, error: undefined, runAt: Math.max(t.runAt, Date.now()), updatedAt: Date.now() });
    if (t.kind !== "react") ctx.afterCommit.agent("concierge", { taskId: id });
    await record(ctx, { id: t.ownerId }, "task.retried", { taskId: id });
    return { status };
  },
});

export const list = app.query({
  access: "frame.read",
  returns: s.array(TaskView),
  capability: { name: "tasks.list", description: "The caller's delegated tasks, newest first, with status, AuthBoundry evidence and results." },
  handler: async (ctx) => {
    const me = await myProfile(ctx);
    if (!me) return [];
    const mine = await ctx.db.find(tasks, { ownerId: me.id }, { orderBy: [{ field: "createdAt", direction: "desc" }], limit: 50 });
    return Promise.all(
      mine.map(async (t) => {
        const post = t.resultPostId ? await ctx.db.get(posts, t.resultPostId) : null;
        return {
          id: t.id, kind: t.kind, capability: t.capability, status: t.status, agent: (await authorById(ctx.db, t.agentId))!, runAt: t.runAt, runs: t.runs,
          draft: t.draft ? { text: t.draft.text, visibility: t.draft.visibility, images: t.draft.media.length } : null,
          result: post ? (await cards(ctx.db, [post], me.id, 0))[0]! : null,
          summary: t.summary ?? null, error: t.error ?? null, decisionId: t.decisionId ?? null, delegationId: t.delegationId ?? null,
          createdAt: t.createdAt, updatedAt: t.updatedAt,
        };
      }),
    );
  },
});

// ----------------------------------------------------------------------------------- Concierge

export const concierge = app.agent("concierge", {
  principal: { id: RESIDENTS.concierge.principal, displayName: RESIDENTS.concierge.displayName },
  roles: ["resident"],
  access: "frame.write",
  description: "Does delegated work for a person, only while AuthBoundry allows it.",
  handler: async (ctx, input: { taskId: string; commentId?: string }) => {
    const me = (await ctx.db.get(profiles, RESIDENTS.concierge.profileId)) ?? fail("FAILED_PRECONDITION", "Concierge has no profile.");
    const task = await ctx.db.get(tasks, input.taskId);
    if (!task || !(task.status === "scheduled" || task.status === "active")) return { skipped: task?.status ?? "missing" };
    if (task.agentId !== me.id) return { skipped: "not mine" };
    const owner = (await ctx.db.get(profiles, task.ownerId))!;

    // Standing work only acts on comments by others on the owner's own posts.
    let target: { post: NonNullable<Awaited<ReturnType<typeof ctx.db.get<typeof posts>>>>; comment: NonNullable<Awaited<ReturnType<typeof ctx.db.get<typeof comments>>>> } | null = null;
    if (task.kind === "react") {
      const comment = input.commentId ? await ctx.db.get(comments, input.commentId) : null;
      const post = comment ? await ctx.db.get(posts, comment.postId) : null;
      if (!comment || comment.deletedAt || !post || post.authorId !== owner.id || comment.authorId === owner.id) return { skipped: "nothing to do" };
      if ((await ctx.db.find(reactions, { target: `comment:${comment.id}`, profileId: owner.id })).length) return { skipped: "already reacted" };
      target = { post, comment };
    }

    // The authority: AuthBoundry, asked now, on the owner's behalf, by Concierge itself (an app.agent
    // decides as its own agent, proven by its credential). No grant to Concierge, no action.
    const decision = await ctx.authority.decide({ capability: task.capability, onBehalfOf: owner.userId });
    const evidence = { decisionId: decision.decisionId ?? undefined, delegationId: decision.delegationId ?? undefined };
    const now = Date.now();
    if (!decision.allowed) {
      const why = decision.reason === "delegation_revoked" ? "you revoked this permission" : decision.reason === "delegation_missing" ? "you haven't granted this permission" : decision.reason === "delegation_expired" ? "this permission expired" : `the authority said: ${decision.reason ?? decision.outcome}`;
      await ctx.db.patch(tasks, task.id, { status: "needs_permission", error: `Stopped: ${why} (${task.capability}).`, ...evidence, updatedAt: now });
      await notify(ctx, { recipient: owner, actor: me, type: "agent.permission_needed", title: `Concierge needs your permission to continue (${task.capability}).`, key: `permission:${task.id}:${decision.decisionId ?? ctx.trigger.idempotencyKey}`, data: { taskId: task.id } });
      await record(ctx, me, "delegation.refused", { taskId: task.id, capability: task.capability, reason: decision.reason ?? decision.outcome, ...evidence }, owner);
      return { refused: decision.reason };
    }

    if (task.kind === "publish") {
      const postId = await publish(ctx, owner, task.draft!, me);
      await ctx.db.patch(tasks, task.id, { status: "completed", resultPostId: postId, runs: task.runs + 1, summary: "Published your post.", ...evidence, updatedAt: now });
      await notify(ctx, { recipient: owner, actor: me, type: "agent.task_completed", title: "Concierge published your scheduled post.", key: `done:${task.id}`, data: { taskId: task.id, postId } });
      await record(ctx, me, "task.completed", { taskId: task.id, postId, capability: task.capability, ...evidence }, owner);
      return { postId };
    }

    if (task.kind === "react") {
      await react(ctx, owner, target!.post, target!.comment, "support", me);
      await ctx.db.patch(tasks, task.id, { runs: task.runs + 1, ...evidence, updatedAt: now });
      await record(ctx, me, "task.acted", { taskId: task.id, postId: target!.post.id, commentId: target!.comment.id, reaction: "support", ...evidence }, owner);
      return { reacted: target!.comment.id };
    }

    // digest: what happened on the owner's posts in the last 7 days, from the records themselves.
    const since = now - 7 * 86_400_000;
    const mine = (await ctx.db.query(posts, { where: [{ field: "authorId", eq: owner.id }], orderBy: [{ field: "createdAt", direction: "desc" }], limit: 100 })).records;
    let reactionCount = 0, commentCount = 0, agentCount = 0;
    const people = new Set<string>();
    for (const p of mine) {
      for (const r of await ctx.db.find(reactions, { postId: p.id })) if (r.createdAt >= since && r.profileId !== owner.id) { reactionCount++; people.add(r.profileId); if (r.viaAgentId || (await ctx.db.get(profiles, r.profileId))?.kind === "agent") agentCount++; }
      for (const c of await ctx.db.find(comments, { postId: p.id })) if (c.createdAt >= since && c.authorId !== owner.id && !c.deletedAt) { commentCount++; people.add(c.authorId); if ((await ctx.db.get(profiles, c.authorId))?.kind === "agent") agentCount++; }
    }
    const newFollowers = (await ctx.db.find(follows, { followeeId: owner.id })).filter((f) => f.createdAt >= since).length;
    const summary = `This week: ${reactionCount} reaction${reactionCount === 1 ? "" : "s"} and ${commentCount} comment${commentCount === 1 ? "" : "s"} from ${people.size} participant${people.size === 1 ? "" : "s"} (${agentCount} by agents), ${newFollowers} new follower${newFollowers === 1 ? "" : "s"}, across ${mine.length} post${mine.length === 1 ? "" : "s"}.`;
    await ctx.db.patch(tasks, task.id, { status: "completed", runs: task.runs + 1, summary, ...evidence, updatedAt: now });
    await notify(ctx, { recipient: owner, actor: me, type: "agent.task_completed", title: "Concierge sent your activity digest.", key: `done:${task.id}`, data: { taskId: task.id } });
    await record(ctx, me, "task.completed", { taskId: task.id, capability: task.capability, ...evidence }, owner);
    return { summary };
  },
});

