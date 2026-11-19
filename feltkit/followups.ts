/**
 * Acting on the network: message drafts and follow-ups.
 *
 * Intent is not execution. Frame never sends a message: a draft is text for the owner to send
 * themselves, wherever they talk to that person. "Sent" is the owner's own confirmation, recorded as
 * an interaction; an agent can only propose it (approval: "required"), and a person approves.
 * A follow-up is a reminder Frame keeps and delivers (a notification at its time, if still open).
 */
import { fail, s, type Doc } from "@feltdb/feltkit";
import { app, drafts, followups, goals, people, profiles } from "./app.js";
import { DAY, history, ownPerson, ownerOf } from "./_network.js";
import { currentJobs, hiringSignals, jobText, knows, loadGraph, orgName, pastJobs, personDomains } from "./_graph.js";
import { insertInteraction } from "./network.js";

const draftOwns = { collection: drafts, id: "draftId", field: "ownerId" } as const;
const followupOwns = { collection: followups, id: "followupId", field: "ownerId" } as const;

const DraftView = s.object({
  id: s.string(), personId: s.string(), displayName: s.string(), purpose: s.string(), text: s.string(), status: s.enum(["draft", "sent", "discarded"]), basis: s.array(s.string()),
  generatedBy: s.string(), generation: s.nullable(s.object({ provider: s.string(), model: s.string(), taskId: s.nullable(s.string()) })), sentAt: s.nullable(s.number()), createdAt: s.number(), updatedAt: s.number(),
});
async function draftView(db: Parameters<typeof ownPerson>[0], d: Doc<typeof drafts.shape>) {
  const p = await db.get(people, d.personId);
  return {
    id: d.id, personId: d.personId, displayName: p?.displayName ?? "?", purpose: d.purpose, text: d.text, status: d.status, basis: d.basis, generatedBy: d.generatedBy,
    generation: d.generation ? { provider: d.generation.provider, model: d.generation.model, taskId: d.generation.taskId ?? null } : null, sentAt: d.sentAt ?? null, createdAt: d.createdAt, updatedAt: d.updatedAt,
  };
}

/**
 * A draft from the record, by rule: who they are now, how the owner knows them, what the owner is
 * looking for, and what's happening at their organization. Every sentence comes from a fact whose
 * evidence is listed in `basis`; nothing is invented, so nothing needs checking before it is used.
 */
export const draft = app.mutation({
  access: "network.write",
  args: { personId: s.string(), purpose: s.enum(["reconnect", "introduction", "followup", "other"]), introduceTo: s.optional(s.string()), note: s.optional(s.string({ maxLength: 500 })) },
  returns: DraftView,
  capability: { name: "message.draft", description: "Prepare a message to someone in the caller's network (reconnect, ask for an introduction to `introduceTo`, follow up), built only from their record; `basis` lists the evidence used. A draft is never sent by Frame." },
  handler: async (ctx, a) => {
    const ownerId = ownerOf(ctx);
    const p = await ownPerson(ctx.db, ownerId, a.personId);
    const g = await loadGraph(ctx.db, ownerId);
    const [goal] = await ctx.db.find(goals, { ownerId });
    const [me] = await ctx.db.find(profiles, { userId: ownerId });
    const basis: string[] = [];
    const first = p.displayName.split(/[\s,]/)[0];
    const lines: string[] = [];
    const rels = knows(g, p.id);
    const ctxRel = rels.find((r) => r.context);
    const last = g.talks.get(p.id)?.[0];
    const cur = currentJobs(g, p.id)[0];
    const prev = pastJobs(g, p.id).find((j) => cur && j.endedByEvidenceId === cur.evidenceId);
    if (a.purpose === "reconnect") {
      lines.push(`Hi ${first},`);
      const since = last ? ` since we last spoke in ${new Date(last.occurredAt).toISOString().slice(0, 7)}` : "";
      if (last) basis.push(last.evidenceId);
      lines.push(`It's been a while${since}${ctxRel ? `, and I still think about ${ctxRel.context!.replace(/\.$/, "")}` : ""}.`);
      if (ctxRel) basis.push(ctxRel.evidenceId);
      if (cur && prev) {
        lines.push(`I saw you moved from ${orgName(g, prev.organizationId)} to ${jobText(g, cur)} — congratulations.`);
        basis.push(cur.evidenceId, prev.evidenceId);
      } else if (cur && cur.title) {
        lines.push(`I hope things are going well as ${jobText(g, cur)}.`);
        basis.push(cur.evidenceId);
      }
      if (goal) {
        const hiring = cur ? (await hiringSignals(ctx.db, ownerId)).get(cur.organizationId) : undefined;
        const domain = goal.domains.find((d) => personDomains(g, p).has(d));
        lines.push(`I'm exploring my next step${goal.text ? ` — ${goal.text}` : ""} — and your perspective${domain ? ` on ${domain === "ai" ? "AI" : domain}` : ""} would mean a lot${hiring?.length ? `, especially as ${orgName(g, cur!.organizationId)} is growing the team` : ""}.`);
        if (hiring?.length) basis.push(hiring[0]!.id);
      }
      lines.push("Would you be open to a 20-minute call in the next couple of weeks?");
    } else if (a.purpose === "introduction") {
      if (!a.introduceTo) fail("INVALID_ARGUMENT", "An introduction request needs introduceTo (the person you'd like to meet).");
      const t = await ownPerson(ctx.db, ownerId, a.introduceTo!);
      const tj = currentJobs(g, t.id)[0];
      const tie = (g.neighbors.get(p.id) ?? []).find((n) => n.personId === t.id);
      if (!tie && !(p.profileId && t.profileId && g.mutual.has([p.profileId, t.profileId].sort().join("|")))) fail("FAILED_PRECONDITION", `Nothing on record says ${p.displayName} knows ${t.displayName}. Record the tie first if you know it (network.addtie).`);
      if (tie) basis.push(tie.tie.evidenceId);
      if (tj) basis.push(tj.evidenceId);
      lines.push(`Hi ${first},`);
      lines.push(`I hope you're well. I'd love to meet ${t.displayName}${tj ? ` (${jobText(g, tj)})` : ""}, and I believe you know each other.`);
      if (goal) lines.push(`I'm exploring my next step — ${goal.text} — and ${t.displayName.split(" ")[0]}'s experience is directly relevant.`);
      lines.push("Would you be comfortable making an introduction? Happy to send a short blurb you can forward. And no pressure at all if it isn't a fit.");
    } else {
      lines.push(`Hi ${first},`);
      lines.push(a.purpose === "followup" ? `Following up on ${last ? `our ${last.kind} on ${new Date(last.occurredAt).toISOString().slice(0, 10)}` : "my last note"}.` : "");
      if (last && a.purpose === "followup") basis.push(last.evidenceId);
    }
    if (a.note) lines.push(a.note);
    lines.push("", `Best,\n${me?.displayName ?? ""}`.trim());
    const now = Date.now();
    const id = await ctx.db.insert(drafts, { ownerId, personId: p.id, purpose: a.purpose, text: lines.filter((l) => l !== "").join("\n\n").replace(/\n\n(Best,)/, "\n\n$1"), status: "draft", basis: [...new Set(basis)].slice(0, 30), generatedBy: "template", createdAt: now, updatedAt: now });
    await history(ctx, p.id, "draft.created", { draftId: id, purpose: a.purpose });
    return draftView(ctx.db, (await ctx.db.get(drafts, id))!);
  },
});

/** A draft written elsewhere (by the owner, or by a model in `assistant:polish`), stored with what produced it. */
export const saveDraft = app.mutation({
  access: "network.write",
  args: { personId: s.string(), purpose: s.enum(["reconnect", "introduction", "followup", "other"]), text: s.string({ minLength: 1, maxLength: 4000 }), basis: s.optional(s.array(s.string(), { maxItems: 30 })), generation: s.optional(s.object({ provider: s.string(), model: s.string(), taskId: s.optional(s.string()) })) },
  returns: DraftView,
  capability: { name: "message.save", description: "Save a message draft the caller (or their assistant) wrote. A model-written draft records which model wrote it. Never sent by Frame." },
  handler: async (ctx, a) => {
    const ownerId = ownerOf(ctx);
    const p = await ownPerson(ctx.db, ownerId, a.personId);
    const now = Date.now();
    const id = await ctx.db.insert(drafts, { ownerId, personId: p.id, purpose: a.purpose, text: a.text, status: "draft", basis: a.basis ?? [], generatedBy: a.generation ? "model" : "user", createdAt: now, updatedAt: now, ...(a.generation ? { generation: a.generation } : {}) });
    await history(ctx, p.id, "draft.created", { draftId: id, purpose: a.purpose, by: a.generation ? `model:${a.generation.provider}/${a.generation.model}` : "user" });
    return draftView(ctx.db, (await ctx.db.get(drafts, id))!);
  },
});

export const editDraft = app.mutation({
  access: "network.write",
  args: { draftId: s.string(), text: s.string({ minLength: 1, maxLength: 4000 }) },
  returns: DraftView,
  owner: draftOwns,
  capability: { name: "message.edit", description: "Change a draft's text (only while it is a draft)." },
  handler: async (ctx, { draftId, text }) => {
    const d = (await ctx.db.get(drafts, draftId))!;
    if (d.status !== "draft") fail("FAILED_PRECONDITION", `This draft is ${d.status}.`);
    await ctx.db.patch(drafts, d.id, { text, updatedAt: Date.now(), ...(d.generatedBy === "template" ? { generatedBy: "user" as const } : {}) });
    return draftView(ctx.db, (await ctx.db.get(drafts, d.id))!);
  },
});

export const discardDraft = app.mutation({
  access: "network.write",
  args: { draftId: s.string() },
  returns: DraftView,
  owner: draftOwns,
  capability: { name: "message.discard", description: "Discard a draft. It is kept, marked discarded." },
  handler: async (ctx, { draftId }) => {
    const d = (await ctx.db.get(drafts, draftId))!;
    if (d.status !== "draft") fail("FAILED_PRECONDITION", `This draft is ${d.status}.`);
    await ctx.db.patch(drafts, d.id, { status: "discarded", updatedAt: Date.now() });
    return draftView(ctx.db, (await ctx.db.get(drafts, d.id))!);
  },
});

/**
 * The owner confirms they sent it (Frame did not, and cannot know otherwise). Records the
 * interaction that relationship strength and reconnection are computed from. Once only. An agent can
 * propose this; it runs when the owner approves it.
 */
export const markSent = app.mutation({
  access: "network.write",
  approval: "required",
  args: { draftId: s.string(), sentAt: s.optional(s.number()), channel: s.optional(s.enum(["email", "message", "other"])) },
  returns: DraftView,
  owner: draftOwns,
  capability: { name: "message.marksent", description: "Confirm the caller sent a draft themselves (Frame never sends). Records the interaction. Once only; an agent's call waits for the person's approval." },
  handler: async (ctx, a) => {
    const ownerId = ownerOf(ctx);
    const d = (await ctx.db.get(drafts, a.draftId))!;
    if (d.status === "sent") fail("FAILED_PRECONDITION", "Already confirmed sent.");
    if (d.status !== "draft") fail("FAILED_PRECONDITION", `This draft is ${d.status}.`);
    const at = Math.min(a.sentAt ?? Date.now(), Date.now());
    const kind = a.channel === "email" ? ("email" as const) : ("message" as const);
    const { interactionId } = await insertInteraction(ctx, ownerId, d.personId, { kind, occurredAt: at, note: `Sent: ${d.purpose} message`, source: "draft" });
    await ctx.db.patch(drafts, d.id, { status: "sent", sentAt: at, interactionId, updatedAt: Date.now() });
    await history(ctx, d.personId, "draft.sent_confirmed", { draftId: d.id, interactionId, confirmedBy: ctx.auth.requirePrincipal().id });
    return draftView(ctx.db, (await ctx.db.get(drafts, d.id))!);
  },
});

export const listDrafts = app.query({
  access: "network.read",
  args: { personId: s.optional(s.string()), status: s.optional(s.enum(["draft", "sent", "discarded"])) },
  returns: s.array(DraftView),
  capability: { name: "message.list", description: "The caller's drafts, newest first (optionally for one person, or by status)." },
  handler: async (ctx, a) => {
    const ownerId = ownerOf(ctx);
    const list = a.personId ? await ctx.db.find(drafts, { ownerId, personId: (await ownPerson(ctx.db, ownerId, a.personId)).id }) : await ctx.db.find(drafts, { ownerId, ...(a.status ? { status: a.status } : {}) }, { orderBy: [{ field: "updatedAt", direction: "desc" }], limit: 100 });
    return Promise.all(list.filter((d) => !a.status || d.status === a.status).sort((x, y) => y.updatedAt - x.updatedAt).map((d) => draftView(ctx.db, d)));
  },
});

// ---------------------------------------------------------------------------------------- follow-ups

const FollowupView = s.object({ id: s.string(), personId: s.string(), displayName: s.string(), dueAt: s.number(), reason: s.string(), status: s.string(), draftId: s.nullable(s.string()), overdue: s.boolean(), createdAt: s.number(), completedAt: s.nullable(s.number()) });

export const createFollowup = app.mutation({
  access: "network.write",
  args: { personId: s.string(), dueAt: s.number(), reason: s.string({ minLength: 1, maxLength: 300 }), draftId: s.optional(s.string()) },
  returns: s.object({ followupId: s.string() }),
  capability: { name: "followup.create", description: "Remind the caller to follow up with someone at dueAt (ms). They get a notification then, if it is still open." },
  handler: async (ctx, a) => {
    const ownerId = ownerOf(ctx);
    const p = await ownPerson(ctx.db, ownerId, a.personId);
    if (a.draftId) {
      const d = await ctx.db.get(drafts, a.draftId);
      if (!d || d.ownerId !== ownerId) fail("NOT_FOUND", "No such draft.");
    }
    if (a.dueAt < Date.now() - DAY) fail("INVALID_ARGUMENT", "A follow-up is due in the future.");
    const followupId = await ctx.db.insert(followups, { ownerId, personId: p.id, dueAt: a.dueAt, reason: a.reason, status: "open", createdAt: Date.now(), ...(a.draftId ? { draftId: a.draftId } : {}) });
    ctx.afterCommit.jobs.enqueue("followup.due", { followupId }, { runAt: new Date(Math.max(a.dueAt, Date.now())).toISOString() });
    await history(ctx, p.id, "followup.created", { followupId, dueAt: a.dueAt });
    return { followupId };
  },
});

/** Job "followup.due": runs as the owner who created it, at its time. Notifies only if still open. */
export const due = app.mutation({
  access: "network.write",
  args: { followupId: s.string() },
  returns: s.object({ notified: s.boolean() }),
  owner: followupOwns,
  handler: async (ctx, { followupId }) => {
    const f = (await ctx.db.get(followups, followupId))!;
    if (f.status !== "open") return { notified: false };
    const p = await ctx.db.get(people, f.personId);
    ctx.afterCommit.notifications.send({ recipient: f.ownerId, type: "network.followup_due", title: `Follow up with ${p?.displayName ?? "someone"}: ${f.reason}`.slice(0, 200), data: { followupId: f.id, personId: f.personId }, idempotencyKey: `followup:${f.id}` });
    return { notified: true };
  },
});

export const completeFollowup = app.mutation({
  access: "network.write",
  args: { followupId: s.string(), outcome: s.enum(["done", "cancelled"]), interaction: s.optional(s.object({ kind: s.enum(["meeting", "call", "email", "message", "introduction", "other"]), note: s.optional(s.string({ maxLength: 1000 })) })) },
  returns: FollowupView,
  owner: followupOwns,
  capability: { name: "followup.complete", description: "Close a follow-up as done (optionally recording the interaction that happened) or cancelled." },
  handler: async (ctx, a) => {
    const ownerId = ownerOf(ctx);
    const f = (await ctx.db.get(followups, a.followupId))!;
    if (f.status !== "open") fail("FAILED_PRECONDITION", `This follow-up is already ${f.status}.`);
    if (a.interaction && a.outcome === "done") await insertInteraction(ctx, ownerId, f.personId, { kind: a.interaction.kind, occurredAt: Date.now(), source: "user", ...(a.interaction.note ? { note: a.interaction.note } : {}) });
    await ctx.db.patch(followups, f.id, { status: a.outcome, completedAt: Date.now() });
    await history(ctx, f.personId, `followup.${a.outcome}`, { followupId: f.id });
    const done = (await ctx.db.get(followups, f.id))!;
    const p = await ctx.db.get(people, f.personId);
    return { id: done.id, personId: done.personId, displayName: p?.displayName ?? "?", dueAt: done.dueAt, reason: done.reason, status: done.status, draftId: done.draftId ?? null, overdue: false, createdAt: done.createdAt, completedAt: done.completedAt ?? null };
  },
});

export const listFollowups = app.query({
  access: "network.read",
  args: { status: s.optional(s.enum(["open", "done", "cancelled"])) },
  returns: s.array(FollowupView),
  capability: { name: "followup.list", description: "The caller's follow-ups (open by default), soonest first, with whether each is overdue." },
  handler: async (ctx, a) => {
    const ownerId = ownerOf(ctx);
    const now = Date.now();
    const list = await ctx.db.find(followups, { ownerId, status: a.status ?? "open" }, { orderBy: [{ field: "dueAt", direction: "asc" }], limit: 200 });
    return Promise.all(list.map(async (f) => {
      const p = await ctx.db.get(people, f.personId);
      return { id: f.id, personId: f.personId, displayName: p?.displayName ?? "?", dueAt: f.dueAt, reason: f.reason, status: f.status, draftId: f.draftId ?? null, overdue: f.status === "open" && f.dueAt < now, createdAt: f.createdAt, completedAt: f.completedAt ?? null };
    }));
  },
});

