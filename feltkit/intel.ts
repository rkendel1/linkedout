/**
 * Professional intelligence over the owner's network: what they're looking for (goals), who is
 * relevant to it and why (recommend), how to reach someone (paths), who they've lost touch with
 * (reconnect), where the opportunities are (opportunities), what changed, and a briefing before a
 * conversation. Every function here is deterministic: it reads durable records and evidence and
 * explains itself with evidence ids. Frame's own social graph and posts are a source, through the
 * same evidence contract as any import (`network.syncframe`).
 */
import { fail, s } from "@feltdb/feltkit";
import { FUNCTIONS, SENIORITY, app, employments, evidence, followups, follows, goals, identifiers, organizations, people, posts, profiles, relationships } from "./app.js";
import { DAY, DOMAIN_NAMES, addEvidence, domainsIn, functionOf, history, isHiringText, organizationNamed, orgKey, ownPerson, ownerOf, seniorityOf, type PersonDoc } from "./_network.js";
import { FRESH_FOR, LEADERSHIP, PersonCard, Position, Reason, card, currentJobs, hiringSignals, jobText, knows, limitations, loadGraph, orgName, pastJobs, personDomains, position, relevance, strength, type Graph, type ReasonT } from "./_graph.js";
import { Interpretation, interpret } from "./_interpret.js";
import { canSee } from "./_frame.js";
import { createPerson, relate } from "./network.js";

// -------------------------------------------------------------------------------------------- goal

const GoalView = s.shape({ text: s.string(), functions: s.array(s.string()), domains: s.array(s.string()), seniority: s.array(s.string()), organizations: s.array(s.object({ id: s.string(), name: s.string() })), updatedAt: s.number() });

export const goal = app.query({
  access: "network.read",
  returns: s.nullable(GoalView),
  capability: { name: "goal.get", description: "What the caller is looking for next (their career goal), as Frame understood it: functions, domains, seniority, target organizations." },
  handler: async (ctx) => {
    const ownerId = ownerOf(ctx);
    const [g] = await ctx.db.find(goals, { ownerId });
    if (!g) return null;
    const orgs = await Promise.all(g.organizationIds.map(async (id) => ({ id, name: (await ctx.db.get(organizations, id))?.name ?? "?" })));
    return { text: g.text, functions: g.functions, domains: g.domains, seniority: g.seniority, organizations: orgs, updatedAt: g.updatedAt };
  },
});

export const setGoal = app.mutation({
  access: "network.write",
  args: {
    text: s.string({ minLength: 3, maxLength: 300 }),
    functions: s.optional(s.array(s.enum(FUNCTIONS), { maxItems: 6 })),
    domains: s.optional(s.array(s.enum(DOMAIN_NAMES), { maxItems: 10 })),
    seniority: s.optional(s.array(s.enum(SENIORITY), { maxItems: 7 })),
    organizations: s.optional(s.array(s.string({ maxLength: 160 }), { maxItems: 20 })),
  },
  returns: s.object({ goal: GoalView.omit("organizations").extend({ organizations: s.array(s.string()) }), understood: s.array(s.string()) }),
  capability: { name: "goal.set", description: "Set what the caller is looking for next, in their words (\"AI product leadership\"). Frame interprets it by rules; any of functions, domains, seniority or organizations given explicitly replace the interpretation." },
  handler: async (ctx, a) => {
    const ownerId = ownerOf(ctx);
    const g = await loadGraph(ctx.db, ownerId);
    const i = interpret(a.text, vocabulary(g));
    const organizationIds: string[] = [...i.organizationIds];
    for (const name of a.organizations ?? []) {
      organizationIds.push(await organizationNamed(ctx, ownerId, name, { sourceType: "user", sourceReference: `goal:${ctx.requestId}`, kind: "user_provided", observedAt: Date.now() }));
    }
    const next = {
      text: a.text.trim(), functions: a.functions ?? i.functions, domains: a.domains ?? i.domains, seniority: a.seniority ?? i.seniority,
      organizationIds: [...new Set(organizationIds)].slice(0, 20), updatedAt: Date.now(),
    };
    const [has] = await ctx.db.find(goals, { ownerId });
    if (has) await ctx.db.patch(goals, has.id, next);
    else await ctx.db.insert(goals, { ownerId, ...next });
    const { organizationIds: orgIds, ...rest } = next;
    return { goal: { ...rest, organizations: orgIds }, understood: i.understood };
  },
});

export const vocabulary = (g: Graph) => ({
  organizations: [...g.orgs.values()].map((o) => ({ id: o.id, name: o.name, nameKey: o.nameKey })),
  people: [...g.people.values()].map((p) => ({ id: p.id, displayName: p.displayName, nameKey: p.nameKey })),
});

// ------------------------------------------------------------------------------------- recommend

const Recommendation = s.object({ person: PersonCard, score: s.number(), reasons: s.array(Reason), limitations: s.array(s.string()) });

export const recommend = app.query({
  access: "network.read",
  args: { goal: s.optional(s.string({ maxLength: 300 })), limit: s.optional(s.integer({ minimum: 1, maximum: 50 })) },
  returns: s.object({ goal: s.nullable(s.object({ text: s.string(), functions: s.array(s.string()), domains: s.array(s.string()), seniority: s.array(s.string()) })), considered: s.integer(), people: s.array(Recommendation), limitations: s.array(s.string()) }),
  capability: {
    name: "intel.recommend",
    description: "People in the caller's own network (direct or historical relationships only) most relevant to their goal (the saved one, or `goal` text), ranked by explainable factors: role, leadership, domain, target organization, active hiring at their organization, past roles, whom they know, and how well the caller knows them. Each reason cites evidence ids.",
  },
  handler: async (ctx, a) => {
    const ownerId = ownerOf(ctx);
    const g = await loadGraph(ctx.db, ownerId);
    const [saved] = await ctx.db.find(goals, { ownerId });
    const target = a.goal ? (() => { const i = interpret(a.goal!, vocabulary(g)); return { text: a.goal!, functions: i.functions, domains: i.domains, seniority: i.seniority, organizationIds: i.organizationIds }; })() : saved;
    if (!target) return { goal: null, considered: 0, people: [], limitations: ["No goal set: say what you're looking for (goal.set), or pass `goal`."] };
    if (!target.functions.length && !target.domains.length && !target.organizationIds.length) {
      return { goal: { text: target.text, functions: [], domains: [], seniority: target.seniority }, considered: 0, people: [], limitations: [`Frame could not find a function, domain or organization in “${target.text}”. Name one (e.g. "product leadership in AI").`] };
    }
    const hiring = await hiringSignals(ctx.db, ownerId);
    const scored: Array<{ p: PersonDoc; r: ReturnType<typeof relevance> }> = [];
    let considered = 0;
    for (const p of g.people.values()) {
      if (!knows(g, p.id).length) continue;
      considered++;
      const r = relevance(g, p, target, hiring);
      if (r.relevant) scored.push({ p, r });
    }
    scored.sort((x, y) => y.r.score - x.r.score || y.r.strength.score - x.r.strength.score || x.p.displayName.localeCompare(y.p.displayName));
    const lim: string[] = [];
    if (!hiring.size) lim.push("No active hiring evidence in your network: record what you know (opportunity.record) or sync Frame posts (network.syncframe).");
    if (![...g.talks.values()].some((l) => l.length)) lim.push("No interactions recorded: relationship strength rests only on connections and your own ratings.");
    return {
      goal: { text: target.text, functions: target.functions, domains: target.domains, seniority: target.seniority }, considered,
      people: scored.slice(0, a.limit ?? 5).map(({ p, r }) => ({ person: card(g, p), score: r.score, reasons: r.reasons, limitations: limitations(g, p) })),
      limitations: lim,
    };
  },
});

// ----------------------------------------------------------------------------------------- paths

const Hop = s.object({ personId: s.string(), displayName: s.string(), role: s.nullable(s.string()), link: s.string(), evidenceIds: s.array(s.string()) });
const PathView = s.object({ kind: s.enum(["direct", "via_tie", "via_frame"]), hops: s.array(Hop), target: s.object({ personId: s.string(), displayName: s.string(), role: s.nullable(s.string()), current: s.boolean() }), explanation: s.string(), firstHopStrength: s.string() });

export const paths = app.query({
  access: "network.read",
  args: { organization: s.optional(s.string({ maxLength: 160 })), personId: s.optional(s.string()), limit: s.optional(s.integer({ minimum: 1, maximum: 50 })) },
  returns: s.object({ target: s.string(), paths: s.array(PathView), limitations: s.array(s.string()) }),
  capability: {
    name: "network.paths",
    description: "Ways the caller could reach people at an organization (or one person): people they know there directly, or someone they know who knows them — by the caller's own record of that tie, or because the two follow each other on Frame. Shared employers are never treated as a tie. An available path is not a promise of an introduction.",
  },
  handler: async (ctx, a) => {
    const ownerId = ownerOf(ctx);
    if (!a.organization === !a.personId) fail("INVALID_ARGUMENT", "Give an organization or a personId.");
    const g = await loadGraph(ctx.db, ownerId);
    let targets: Array<{ p: PersonDoc; role: string | null; current: boolean; evidenceId: string | null }>;
    let label: string;
    if (a.personId) {
      const p = await ownPerson(ctx.db, ownerId, a.personId);
      const j = currentJobs(g, p.id)[0];
      targets = [{ p, role: j ? jobText(g, j) : null, current: true, evidenceId: j?.evidenceId ?? null }];
      label = p.displayName;
    } else {
      const key = orgKey(a.organization!);
      const orgIds = new Set([...g.orgs.values()].filter((o) => o.nameKey === key || o.nameKey.startsWith(`${key} `)).map((o) => o.id));
      label = [...g.orgs.values()].find((o) => orgIds.has(o.id))?.name ?? a.organization!;
      if (!orgIds.size) return { target: label, paths: [], limitations: [`No one in your network is recorded at ${a.organization}.`] };
      targets = [];
      for (const p of g.people.values()) {
        const jobs = (g.jobs.get(p.id) ?? []).filter((j) => orgIds.has(j.organizationId)).sort((x, y) => Number(y.current) - Number(x.current));
        if (jobs[0]) targets.push({ p, role: jobText(g, jobs[0]), current: jobs[0].current, evidenceId: jobs[0].evidenceId });
      }
    }
    type HopT = { personId: string; displayName: string; role: string | null; link: string; evidenceIds: string[] };
    const out: Array<{ kind: "direct" | "via_tie" | "via_frame"; hops: HopT[]; target: { personId: string; displayName: string; role: string | null; current: boolean }; explanation: string; firstHopStrength: string; rank: number }> = [];
    const hop = (p: PersonDoc, link: string, evidenceIds: string[]) => ({ personId: p.id, displayName: p.displayName, role: currentJobs(g, p.id)[0] ? jobText(g, currentJobs(g, p.id)[0]!) : null, link, evidenceIds });
    const level = { strong: 3, medium: 2, weak: 1, unknown: 0, none: -1 } as const;
    for (const t of targets) {
      const tgt = { personId: t.p.id, displayName: t.p.displayName, role: t.role, current: t.current };
      const tEv = t.evidenceId ? [t.evidenceId] : [];
      const direct = knows(g, t.p.id);
      if (direct.length) {
        const st = strength(g, t.p.id);
        out.push({ kind: "direct", hops: [hop(t.p, `You know them (${direct.map((r) => r.source.replace(/_/g, " ")).join(", ")})`, [...direct.map((r) => r.evidenceId), ...tEv])], target: tgt, explanation: `You know ${t.p.displayName} directly${t.role ? ` — ${t.current ? "" : "formerly "}${t.role}` : ""}.${a.organization && t.current ? " They may introduce you to colleagues." : ""}`, firstHopStrength: st.level, rank: 100 + level[st.level] * 10 + (t.current ? 5 : 0) });
      }
      const seen = new Set<string>();
      for (const n of g.neighbors.get(t.p.id) ?? []) {
        const via = g.people.get(n.personId);
        if (!via || !knows(g, via.id).length || seen.has(via.id)) continue;
        seen.add(via.id);
        const st = strength(g, via.id);
        out.push({ kind: "via_tie", hops: [hop(via, "You know them", knows(g, via.id).map((r) => r.evidenceId)), hop(t.p, `${via.displayName} knows them (${n.tie.basis === "user_provided" ? "your record" : "imported"}${n.tie.context ? `: ${n.tie.context}` : ""})`, [n.tie.evidenceId, ...tEv])], target: tgt, explanation: `${via.displayName} knows ${t.p.displayName}${t.role ? ` (${t.role})` : ""}. You could ask ${via.displayName.split(" ")[0]} for an introduction.`, firstHopStrength: st.level, rank: 50 + level[st.level] * 10 + (t.current ? 5 : 0) });
      }
      if (t.p.profileId) {
        for (const via of g.people.values()) {
          if (seen.has(via.id) || via.id === t.p.id || !via.profileId || !knows(g, via.id).length) continue;
          if (!g.mutual.has([via.profileId, t.p.profileId].sort().join("|"))) continue;
          seen.add(via.id);
          const st = strength(g, via.id);
          out.push({ kind: "via_frame", hops: [hop(via, "You know them", knows(g, via.id).map((r) => r.evidenceId)), hop(t.p, `They follow each other on Frame (public)`, tEv)], target: tgt, explanation: `${via.displayName} and ${t.p.displayName} follow each other on Frame. That is a public signal they know each other, not a confirmed relationship.`, firstHopStrength: st.level, rank: 30 + level[st.level] * 10 + (t.current ? 5 : 0) });
        }
      }
    }
    out.sort((x, y) => y.rank - x.rank);
    const lim: string[] = [];
    if (!out.length) lim.push(`No known path to ${label}: no one you know is recorded there, and no recorded tie or mutual Frame follow leads there.`);
    if (!out.some((p) => p.kind !== "direct")) lim.push("Second-degree paths use only ties you recorded (network.addtie) and mutual Frame follows of people you linked; none lead here yet.");
    return { target: label, paths: out.slice(0, a.limit ?? 20).map(({ rank: _r, ...p }) => p), limitations: lim };
  },
});

// -------------------------------------------------------------------------------------- reconnect

export const reconnect = app.query({
  access: "network.read",
  args: { limit: s.optional(s.integer({ minimum: 1, maximum: 50 })), dormantDays: s.optional(s.integer({ minimum: 30, maximum: 3650 })) },
  returns: s.object({ people: s.array(s.object({ person: PersonCard, lastInteractionAt: s.nullable(s.number()), why: s.array(Reason), score: s.number() })), limitations: s.array(s.string()) }),
  capability: { name: "intel.reconnect", description: "People the caller knows but has not interacted with recently (default 180 days, or never recorded), most worth reconnecting with first: relevance to their goal, then how well they know them." },
  handler: async (ctx, a) => {
    const ownerId = ownerOf(ctx);
    const g = await loadGraph(ctx.db, ownerId);
    const [goalDoc] = await ctx.db.find(goals, { ownerId });
    const hiring = await hiringSignals(ctx.db, ownerId);
    const cutoff = Date.now() - (a.dormantDays ?? 180) * DAY;
    const list = [];
    for (const p of g.people.values()) {
      if (!knows(g, p.id).length) continue;
      const last = g.talks.get(p.id)?.[0]?.occurredAt ?? null;
      if (last !== null && last > cutoff) continue;
      const why: ReasonT[] = [{ factor: "dormant", text: last ? `Last interaction ${new Date(last).toISOString().slice(0, 10)}` : `No interaction recorded${knows(g, p.id)[0]?.establishedAt ? ` since connecting in ${knows(g, p.id)[0]!.establishedAt!.slice(0, 4)}` : ""}`, weight: 0, evidenceIds: [] }];
      const r = goalDoc ? relevance(g, p, goalDoc, hiring) : null;
      if (r?.relevant) why.push(...r.reasons.filter((x) => x.factor !== "strength"));
      const st = strength(g, p.id);
      why.push(...st.factors);
      const score = (r?.relevant ? r.score : 0) + st.score;
      list.push({ p, last, why, score });
    }
    list.sort((x, y) => y.score - x.score || x.p.displayName.localeCompare(y.p.displayName));
    const lim = goalDoc ? [] : ["No goal set, so relevance is not considered: set one with goal.set."];
    return { people: list.slice(0, a.limit ?? 10).map((x) => ({ person: card(g, x.p), lastInteractionAt: x.last, why: x.why, score: x.score })), limitations: lim };
  },
});

// ---------------------------------------------------------------------------------- opportunities

const OpportunityView = s.object({
  organizationId: s.string(), organization: s.string(), roles: s.array(s.string()), active: s.boolean(), latestObservedAt: s.number(), validUntil: s.number(),
  evidence: s.array(s.object({ id: s.string(), text: s.string(), kind: s.string(), sourceType: s.string(), sourceUri: s.nullable(s.string()), observedAt: s.number() })),
  contacts: s.array(s.object({ personId: s.string(), displayName: s.string(), position: Position, relationship: s.string() })),
  relevance: s.array(s.string()),
});

export const opportunities = app.query({
  access: "network.read",
  args: { includeStale: s.optional(s.boolean()) },
  returns: s.array(OpportunityView),
  capability: { name: "opportunity.search", description: "Hiring at organizations in the caller's network, consolidated per organization, each with its evidence (source, date, kind), the caller's contacts there, and why it may be relevant to their goal. Stale signals (past their validity, default 60 days) are excluded unless includeStale." },
  handler: async (ctx, { includeStale }) => {
    const ownerId = ownerOf(ctx);
    const g = await loadGraph(ctx.db, ownerId);
    const [goalDoc] = await ctx.db.find(goals, { ownerId });
    const signals = await hiringSignals(ctx.db, ownerId, Date.now(), includeStale);
    const now = Date.now();
    const out = [];
    for (const [orgId, list] of signals) {
      const org = g.orgs.get(orgId);
      if (!org) continue;
      const validUntil = Math.max(...list.map((e) => e.validUntil ?? e.observedAt + FRESH_FOR));
      const roles = [...new Set(list.map((e) => e.objectValue.split(" — ")[0]!.trim()).filter(Boolean))];
      const contacts = [];
      for (const p of g.people.values()) {
        const j = (g.jobs.get(p.id) ?? []).find((x) => x.organizationId === orgId && x.current);
        if (j) contacts.push({ personId: p.id, displayName: p.displayName, position: position(g, j), relationship: card(g, p).relationship });
      }
      const rel: string[] = [];
      if (goalDoc) {
        const text = `${roles.join(" ")} ${org.name} ${org.industry ?? ""}`;
        const ds = domainsIn(text).filter((d) => goalDoc.domains.includes(d));
        if (ds.length) rel.push(`In your domain: ${ds.join(", ")}`);
        const fns = roles.map(functionOf).filter((f) => goalDoc.functions.includes(f));
        if (fns.length) rel.push(`In your function: ${[...new Set(fns)].join(", ")}`);
        if (roles.some((r) => LEADERSHIP.has(seniorityOf(r)))) rel.push("A leadership role");
        if (goalDoc.organizationIds.includes(orgId)) rel.push("A company you're targeting");
      }
      out.push({
        organizationId: orgId, organization: org.name, roles, active: validUntil >= now, latestObservedAt: Math.max(...list.map((e) => e.observedAt)), validUntil,
        evidence: list.map((e) => ({ id: e.id, text: e.objectValue, kind: e.kind, sourceType: e.sourceType, sourceUri: e.sourceUri ?? null, observedAt: e.observedAt })),
        contacts, relevance: rel,
      });
    }
    return out.sort((a, b) => b.relevance.length - a.relevance.length || b.contacts.length - a.contacts.length || b.latestObservedAt - a.latestObservedAt);
  },
});

export const recordHiring = app.mutation({
  access: "network.write",
  args: { organization: s.string({ minLength: 1, maxLength: 160 }), role: s.string({ minLength: 1, maxLength: 200 }), sourceUri: s.optional(s.string({ maxLength: 500 })), note: s.optional(s.string({ maxLength: 300 })), observedAt: s.optional(s.number()), validDays: s.optional(s.integer({ minimum: 1, maximum: 365 })) },
  returns: s.object({ evidenceId: s.string(), organizationId: s.string(), created: s.boolean() }),
  capability: { name: "opportunity.record", description: "Record that an organization is hiring for a role, on the caller's word, citing a source (a job posting URL) where there is one. It stops counting as active after validDays (default 60)." },
  handler: async (ctx, a) => {
    const ownerId = ownerOf(ctx);
    if (a.sourceUri && !/^https?:\/\//.test(a.sourceUri)) fail("INVALID_ARGUMENT", "sourceUri must be an http(s) URL.");
    const observedAt = a.observedAt ?? Date.now();
    const src = { sourceType: a.sourceUri ? ("public_url" as const) : ("user" as const), sourceReference: `opportunity:${ctx.requestId}`, kind: "user_provided" as const, observedAt };
    const organizationId = await organizationNamed(ctx, ownerId, a.organization, src);
    const ev = await addEvidence(ctx, ownerId, {
      subjectType: "organization", subjectId: organizationId, predicate: "hiring", objectValue: `${a.role.trim()}${a.note ? ` — ${a.note}` : ""}`, confidence: a.sourceUri ? 0.9 : 0.7,
      validUntil: observedAt + (a.validDays ?? 60) * DAY, ...src, ...(a.sourceUri ? { sourceUri: a.sourceUri } : {}),
    });
    return { evidenceId: ev.id, organizationId, created: ev.created };
  },
});

// ----------------------------------------------------------------------------------- Frame source

/**
 * Bring what Frame itself knows into the owner's network, through the evidence contract:
 * - the people the owner follows on Frame become direct relationships (source frame_follow); an
 *   unfollow ends that relationship (kept, status "ended");
 * - public hiring posts by people the owner linked become hiring evidence for their current
 *   organization (source frame_post, the post's id and date), valid for 60 days.
 * Idempotent: running it twice adds nothing.
 */
export const syncFrame = app.mutation({
  access: "network.write",
  returns: s.object({ followed: s.integer(), added: s.integer(), ended: s.integer(), hiringSignals: s.integer() }),
  capability: { name: "network.syncframe", description: "Bring the caller's Frame follows into their network as direct relationships, and public hiring posts by people they linked as hiring evidence for those people's organizations. Idempotent." },
  handler: async (ctx) => {
    const ownerId = ownerOf(ctx);
    const [me] = await ctx.db.find(profiles, { userId: ownerId });
    if (!me) fail("FAILED_PRECONDITION", "Create your Frame profile first.");
    const now = Date.now();
    const edges = await ctx.db.find(follows, { followerId: me!.id });
    let added = 0, ended = 0, hiringCount = 0;
    const followed = new Set<string>();
    for (const f of edges) {
      const prof = await ctx.db.get(profiles, f.followeeId);
      if (!prof || prof.kind !== "person") continue;
      followed.add(prof.id);
      const [ident] = await ctx.db.find(identifiers, { ownerId, kind: "frame", value: prof.id });
      let personId = ident?.personId;
      if (personId) personId = (await ownPerson(ctx.db, ownerId, personId)).id;
      const src = { sourceType: "frame_follow" as const, sourceReference: f.id, kind: "observed" as const, observedAt: f.createdAt };
      if (!personId) {
        personId = await createPerson(ctx, ownerId, { displayName: prof.displayName, profileId: prof.id, ...(prof.bio ? { headline: prof.bio.slice(0, 300) } : {}) }, { ...src, sourceType: "frame_profile" });
        const ev = await addEvidence(ctx, ownerId, { subjectType: "person", subjectId: personId, predicate: "frame", objectValue: prof.id, confidence: 1, ...src, sourceType: "frame_profile" });
        await ctx.db.insert(identifiers, { ownerId, personId, kind: "frame", value: prof.id, evidenceId: ev.id, createdAt: now });
      }
      const [rel] = await ctx.db.find(relationships, { ownerId, personId, source: "frame_follow" });
      if (!rel) {
        await relate(ctx, ownerId, personId, { type: "direct", establishedAt: new Date(f.createdAt).toISOString().slice(0, 10), sourceRecordId: f.id }, src);
        added++;
      } else if (rel.status !== "active") await ctx.db.patch(relationships, rel.id, { status: "active", updatedAt: now });
    }
    for (const r of await ctx.db.find(relationships, { ownerId, source: "frame_follow" })) {
      if (r.status !== "active") continue;
      const p = await ctx.db.get(people, r.personId);
      if (p?.profileId && !followed.has(p.profileId)) {
        await ctx.db.patch(relationships, r.id, { status: "ended", updatedAt: now });
        await history(ctx, p.id, "relationship.ended", { relationshipId: r.id, reason: "unfollowed on Frame" });
        ended++;
      }
    }
    // Hiring posts by linked people, as the owner can see them.
    for (const p of await ctx.db.find(people, { ownerId, status: "active" })) {
      if (!p.profileId) continue;
      const jobs = (await ctx.db.find(employments, { ownerId, personId: p.id })).filter((j) => j.current);
      const { records } = await ctx.db.query(posts, { where: [{ field: "authorId", eq: p.profileId }, { field: "createdAt", gt: now - FRESH_FOR }], orderBy: [{ field: "createdAt", direction: "desc" }], limit: 20 });
      for (const post of records) {
        if (!isHiringText(post.text) || !(await canSee(ctx.db, post, me!))) continue;
        const subject = jobs[0] ? { subjectType: "organization" as const, subjectId: jobs[0].organizationId } : { subjectType: "person" as const, subjectId: p.id };
        const ev = await addEvidence(ctx, ownerId, {
          ...subject, predicate: "hiring", objectValue: `${post.text.replace(/\s+/g, " ").slice(0, 160)} — posted by ${p.displayName} on Frame`, kind: "observed", sourceType: "frame_post",
          sourceReference: post.id, sourceUri: `/p/${post.id}`, observedAt: post.createdAt, publishedAt: post.createdAt, validUntil: post.createdAt + FRESH_FOR, confidence: jobs[0] ? 0.7 : 0.5,
        });
        if (ev.created) hiringCount++;
      }
    }
    return { followed: followed.size, added, ended, hiringSignals: hiringCount };
  },
});

// ---------------------------------------------------------------------------------------- briefing

const Fact = s.object({ text: s.string(), evidenceIds: s.array(s.string()) });

export const briefing = app.query({
  access: "network.read",
  args: { personId: s.string() },
  returns: s.object({
    person: PersonCard,
    verified: s.array(Fact), imported: s.array(Fact), observed: s.array(Fact), inferred: s.array(Fact),
    recentPosts: s.array(s.object({ id: s.string(), text: s.string(), createdAt: s.number() })),
    sharedInterests: s.array(s.string()),
    mutualPeople: s.array(s.object({ id: s.string(), displayName: s.string() })),
    hiringAtTheirOrganization: s.array(Fact),
    openFollowups: s.array(s.object({ id: s.string(), dueAt: s.number(), reason: s.string() })),
    suggestions: s.array(s.string()),
    limitations: s.array(s.string()),
  }),
  capability: { name: "briefing.person", description: "Prepare for a conversation with someone in the caller's network: what is verified (the caller's word), imported, observed (Frame), and inferred (labelled), their recent public Frame posts, shared interests and people, hiring at their organization, open follow-ups, and suggested topics (suggestions, not facts)." },
  handler: async (ctx, { personId }) => {
    const ownerId = ownerOf(ctx);
    const p = await ownPerson(ctx.db, ownerId, personId);
    const g = await loadGraph(ctx.db, ownerId);
    const evs = await ctx.db.find(evidence, { ownerId, subjectType: "person", subjectId: p.id });
    const live = evs.filter((e) => e.verification !== "disputed" && e.verification !== "superseded" && !["name", "email", "linkedin", "frame"].includes(e.predicate));
    const fact = (e: (typeof evs)[number]) => ({ text: `${e.predicate.replace(/_/g, " ")}: ${e.objectValue}`, evidenceIds: [e.id] });
    const inferred = [...personDomains(g, p).values()].map((d) => ({ text: `Works in ${d.text} (inferred from words in their record)`, evidenceIds: d.evidenceIds }));
    for (const j of currentJobs(g, p.id)) inferred.push({ text: `Seniority “${j.seniority}”, function “${j.function}” — inferred from the title “${j.title}”`, evidenceIds: [j.evidenceId] });
    const prof = p.profileId ? await ctx.db.get(profiles, p.profileId) : null;
    const recent = prof ? (await ctx.db.query(posts, { where: [{ field: "authorId", eq: prof.id }], orderBy: [{ field: "createdAt", direction: "desc" }], limit: 10 })).records : [];
    const visible = [];
    for (const post of recent) if (await canSee(ctx.db, post, g.me)) visible.push({ id: post.id, text: post.text.slice(0, 280), createdAt: post.createdAt });
    const shared = prof && g.me ? prof.interests.filter((i) => g.me!.interests.includes(i)) : [];
    const mutual = (g.neighbors.get(p.id) ?? []).filter((n) => knows(g, n.personId).length).map((n) => ({ id: n.personId, displayName: g.people.get(n.personId)?.displayName ?? "?" }));
    const hiring = await hiringSignals(ctx.db, ownerId);
    const hiringFacts = currentJobs(g, p.id).flatMap((j) => (hiring.get(j.organizationId) ?? []).map((e) => ({ text: `${orgName(g, j.organizationId)} is hiring: ${e.objectValue}`, evidenceIds: [e.id] })));
    const open = (await ctx.db.find(followups, { ownerId, personId: p.id })).filter((f) => f.status === "open").map((f) => ({ id: f.id, dueAt: f.dueAt, reason: f.reason }));
    const suggestions: string[] = [];
    const cur = currentJobs(g, p.id)[0];
    const prev = pastJobs(g, p.id).sort((x, y) => y.createdAt - x.createdAt)[0];
    if (cur && prev && cur.endedByEvidenceId === undefined && prev.endedByEvidenceId === cur.evidenceId) suggestions.push(`Ask how the move from ${orgName(g, prev.organizationId)} to ${orgName(g, cur.organizationId)} is going.`);
    if (hiringFacts.length) suggestions.push(`Ask about the hiring at ${orgName(g, cur!.organizationId)} and what the team needs.`);
    if (shared.length) suggestions.push(`You share interests on Frame: ${shared.map((i) => `#${i}`).join(", ")}.`);
    if (visible[0]) suggestions.push(`They recently posted on Frame: “${visible[0].text.slice(0, 80)}${visible[0].text.length > 80 ? "…" : ""}”`);
    if (mutual.length) suggestions.push(`You both know ${mutual.slice(0, 3).map((m) => m.displayName).join(", ")}.`);
    if (open.length) suggestions.push(`Open follow-up: ${open[0]!.reason}`);
    const lim = limitations(g, p);
    if (!prof) lim.push("Not linked to a Frame profile: no recent public activity to show (network.linkprofile).");
    return {
      person: card(g, p),
      verified: live.filter((e) => e.kind === "user_provided").map(fact), imported: live.filter((e) => e.kind === "imported").map(fact), observed: live.filter((e) => e.kind === "observed").map(fact), inferred,
      recentPosts: visible.slice(0, 5), sharedInterests: shared, mutualPeople: mutual, hiringAtTheirOrganization: hiringFacts, openFollowups: open, suggestions, limitations: lim,
    };
  },
});

// ----------------------------------------------------------------------------------------- changes

export const changes = app.query({
  access: "network.read",
  args: { days: s.optional(s.integer({ minimum: 1, maximum: 365 })) },
  returns: s.object({
    since: s.number(),
    moves: s.array(s.object({ personId: s.string(), displayName: s.string(), from: s.nullable(s.string()), to: s.string(), observedAt: s.number(), evidenceIds: s.array(s.string()) })),
    hiring: s.array(s.object({ organization: s.string(), text: s.string(), sourceType: s.string(), observedAt: s.number(), evidenceId: s.string() })),
    followupsDue: s.array(s.object({ id: s.string(), personId: s.string(), displayName: s.string(), dueAt: s.number(), reason: s.string(), overdue: s.boolean() })),
  }),
  capability: { name: "briefing.changes", description: "What changed in the caller's network in the last `days` (default 30): people who moved to a new position (observed against their previous one), new hiring evidence, and follow-ups due in the next week or overdue." },
  handler: async (ctx, { days }) => {
    const ownerId = ownerOf(ctx);
    const since = Date.now() - (days ?? 30) * DAY;
    const g = await loadGraph(ctx.db, ownerId);
    const moves = [];
    for (const [pid, jobs] of g.jobs) {
      const p = g.people.get(pid);
      if (!p) continue;
      for (const j of jobs.filter((x) => x.current && x.createdAt >= since)) {
        const prev = jobs.find((x) => x.endedByEvidenceId === j.evidenceId);
        if (!prev) continue;
        moves.push({ personId: pid, displayName: p.displayName, from: jobText(g, prev), to: jobText(g, j), observedAt: j.createdAt, evidenceIds: [j.evidenceId, prev.evidenceId] });
      }
    }
    const hiring = [];
    for (const [orgId, list] of await hiringSignals(ctx.db, ownerId)) {
      for (const e of list) if (e.capturedAt >= since) hiring.push({ organization: orgName(g, orgId), text: e.objectValue, sourceType: e.sourceType, observedAt: e.observedAt, evidenceId: e.id });
    }
    const now = Date.now();
    const due = (await ctx.db.find(followups, { ownerId, status: "open" })).filter((f) => f.dueAt < now + 7 * DAY).sort((a, b) => a.dueAt - b.dueAt);
    return {
      since, moves: moves.sort((a, b) => b.observedAt - a.observedAt), hiring: hiring.sort((a, b) => b.observedAt - a.observedAt),
      followupsDue: due.map((f) => ({ id: f.id, personId: f.personId, displayName: g.people.get(f.personId)?.displayName ?? "?", dueAt: f.dueAt, reason: f.reason, overdue: f.dueAt < now })),
    };
  },
});

// -------------------------------------------------------------------------------------- interpret

export const interpretQuestion = app.query({
  access: "network.read",
  args: { question: s.string({ minLength: 1, maxLength: 500 }) },
  returns: Interpretation,
  capability: { name: "intel.interpret", description: "How Frame's rules understand a question about the caller's network: the intent (recommend, search, paths, reconnect, opportunities, briefing, changes) and the functions, seniority, domains, organizations and people it names. Organizations and people are recognized only if they are in the caller's network." },
  handler: async (ctx, { question }) => interpret(question, vocabulary(await loadGraph(ctx.db, ownerOf(ctx)))),
});

