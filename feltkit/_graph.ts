/**
 * The owner's network as one in-memory graph, read from FeltDB for one request and discarded. Search,
 * relevance, introduction paths, reconnection and opportunities are all computed from it, so none of
 * them is ever stored as a second source of truth. Every derived statement carries the evidence ids
 * it rests on. Not a function module.
 *
 * Scale: a request reads the owner's whole network (people, positions, relationships, ties,
 * interactions). That is a few thousand records for a large personal network; see the gap register.
 */
import { s, type DatabaseReader, type Doc } from "@feltdb/feltkit";
import { employments, evidence, follows, goals, interactions, organizations, people, personSkills, profiles, relationships, ties } from "./app.js";
import { DAY, dateMs, domainsIn, type PersonDoc } from "./_network.js";

type Emp = Doc<typeof employments.shape>;
type Org = Doc<typeof organizations.shape>;
type Rel = Doc<typeof relationships.shape>;
type Tie = Doc<typeof ties.shape>;
type Interaction = Doc<typeof interactions.shape>;
type Profile = Doc<typeof profiles.shape>;
export type Goal = Doc<typeof goals.shape>;

export const LEADERSHIP = new Set(["director", "vp", "cxo", "founder"]);

export interface Graph {
  ownerId: string;
  me: Profile | null;
  people: Map<string, PersonDoc>;
  orgs: Map<string, Org>;
  jobs: Map<string, Emp[]>;
  skills: Map<string, Array<{ skill: string; evidenceId: string }>>;
  rels: Map<string, Rel[]>;
  neighbors: Map<string, Array<{ personId: string; tie: Tie }>>;
  talks: Map<string, Interaction[]>;
  /** Evidence the owner disputed: facts resting on it are not used. */
  disputed: Set<string>;
  /** Pairs of linked Frame profiles that follow each other ("a|b", a < b), and who the owner follows. */
  mutual: Set<string>;
  iFollow: Set<string>;
  followsMe: Set<string>;
  profileOf: Map<string, Profile>;
}

const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => (m.get(k) ?? m.set(k, []).get(k)!).push(v);

export async function loadGraph(db: DatabaseReader, ownerId: string): Promise<Graph> {
  const [ppl, emps, orgs, skills, rels, tieList, talks, disputed, [me]] = await Promise.all([
    db.find(people, { ownerId, status: "active" }),
    db.find(employments, { ownerId }),
    db.find(organizations, { ownerId }),
    db.find(personSkills, { ownerId }),
    db.find(relationships, { ownerId }),
    db.find(ties, { ownerId }),
    db.find(interactions, { ownerId }),
    db.find(evidence, { ownerId, verification: "disputed" }),
    db.find(profiles, { userId: ownerId }),
  ]);
  const g: Graph = {
    ownerId, me: me ?? null, people: new Map(ppl.map((p) => [p.id, p])), orgs: new Map(orgs.map((o) => [o.id, o])),
    jobs: new Map(), skills: new Map(), rels: new Map(), neighbors: new Map(), talks: new Map(),
    disputed: new Set(disputed.map((e) => e.id)), mutual: new Set(), iFollow: new Set(), followsMe: new Set(), profileOf: new Map(),
  };
  for (const e of emps) if (!g.disputed.has(e.evidenceId)) push(g.jobs, e.personId, e);
  for (const k of skills) if (!g.disputed.has(k.evidenceId)) push(g.skills, k.personId, { skill: k.skill, evidenceId: k.evidenceId });
  for (const r of rels) if (r.status === "active" && !g.disputed.has(r.evidenceId)) push(g.rels, r.personId, r);
  for (const t of tieList) {
    if (g.disputed.has(t.evidenceId)) continue;
    push(g.neighbors, t.aId, { personId: t.bId, tie: t });
    push(g.neighbors, t.bId, { personId: t.aId, tie: t });
  }
  for (const i of talks) push(g.talks, i.personId, i);
  for (const list of g.talks.values()) list.sort((a, b) => b.occurredAt - a.occurredAt);

  // Frame's public follow graph among the profiles the owner linked (and the owner's own).
  const linked = ppl.filter((p) => p.profileId).map((p) => p.profileId!);
  const ids = [...new Set([...linked, ...(me ? [me.id] : [])])];
  for (let i = 0; i < ids.length; i += 256) {
    const chunk = ids.slice(i, i + 256);
    const [{ records: out }, profs] = await Promise.all([
      db.query(follows, { where: [{ field: "followerId", in: chunk }], limit: 1000 }),
      Promise.all(chunk.map((id) => db.get(profiles, id))),
    ]);
    for (const p of profs) if (p) g.profileOf.set(p.id, p);
    const set = new Set(out.map((f) => `${f.followerId}>${f.followeeId}`));
    for (const f of out) {
      if (set.has(`${f.followeeId}>${f.followerId}`)) g.mutual.add([f.followerId, f.followeeId].sort().join("|"));
      if (me && f.followerId === me.id) g.iFollow.add(f.followeeId);
      if (me && f.followeeId === me.id) g.followsMe.add(f.followerId);
    }
  }
  return g;
}

// ---------------------------------------------------------------------------------------- reasons

export const Reason = s.object({ factor: s.string(), text: s.string(), weight: s.number(), evidenceIds: s.array(s.string()) });
export type ReasonT = { factor: string; text: string; weight: number; evidenceIds: string[] };

export const currentJobs = (g: Graph, personId: string) => (g.jobs.get(personId) ?? []).filter((j) => j.current);
export const pastJobs = (g: Graph, personId: string) => (g.jobs.get(personId) ?? []).filter((j) => !j.current);
export const orgName = (g: Graph, id: string) => g.orgs.get(id)?.name ?? "an organization";
export const jobText = (g: Graph, j: Emp) => `${j.title || "works"} at ${orgName(g, j.organizationId)}`;

/** Established relationships: direct or historical, active, not disputed. "suggested" never counts. */
export const knows = (g: Graph, personId: string) => (g.rels.get(personId) ?? []).filter((r) => r.type !== "suggested");

/** The domains a person is in, each with where it was seen and the evidence. */
export function personDomains(g: Graph, p: PersonDoc): Map<string, ReasonT> {
  const out = new Map<string, ReasonT>();
  const see = (text: string, where: string, evidenceIds: string[]) => {
    for (const d of domainsIn(text)) if (!out.has(d)) out.set(d, { factor: "domain", text: `${d.toUpperCase() === d ? d : d === "ai" ? "AI" : d} — ${where}`, weight: 0, evidenceIds });
  };
  for (const j of currentJobs(g, p.id)) {
    const o = g.orgs.get(j.organizationId);
    see(j.title, `title "${j.title}"`, [j.evidenceId]);
    if (o) see(`${o.name} ${o.industry ?? ""}`, `works at ${o.name}${o.industry ? ` (${o.industry})` : ""}`, [j.evidenceId]);
  }
  if (p.headline) see(p.headline, `headline "${p.headline}"`, []);
  for (const k of g.skills.get(p.id) ?? []) see(k.skill, `skill "${k.skill}"`, [k.evidenceId]);
  return out;
}

/**
 * How well the owner knows a person, from explainable factors only: what the owner said, what
 * actually happened, and how long it has been. Popularity plays no part. "unknown" is an honest
 * answer when nothing but a connection is recorded.
 */
export function strength(g: Graph, personId: string, now = Date.now()) {
  const factors: ReasonT[] = [];
  const rels = knows(g, personId);
  const talks = g.talks.get(personId) ?? [];
  const closeness = Math.max(0, ...rels.map((r) => r.closeness ?? 0));
  if (closeness) factors.push({ factor: "closeness", text: `You rated closeness ${closeness}/5`, weight: closeness >= 4 ? 3 : closeness === 3 ? 2 : 0, evidenceIds: rels.filter((r) => r.closeness).map((r) => r.evidenceId) });
  const hist = rels.find((r) => r.type === "historical" || r.context);
  if (hist) factors.push({ factor: "history", text: hist.context ? `You recorded: “${hist.context}”` : "You recorded a past working relationship", weight: 2, evidenceIds: [hist.evidenceId] });
  const year = talks.filter((t) => t.occurredAt > now - 365 * DAY);
  if (year.length) factors.push({ factor: "interactions", text: `${year.length} interaction${year.length > 1 ? "s" : ""} in the past year`, weight: Math.min(year.length, 3), evidenceIds: year.slice(0, 5).map((t) => t.evidenceId) });
  if (talks[0] && talks[0].occurredAt > now - 90 * DAY) factors.push({ factor: "recent", text: "Talked in the last 90 days", weight: 1, evidenceIds: [talks[0].evidenceId] });
  if (talks.some((t) => t.kind === "introduction")) factors.push({ factor: "introduction", text: "An introduction has happened between you", weight: 1, evidenceIds: talks.filter((t) => t.kind === "introduction").map((t) => t.evidenceId) });
  const p = g.people.get(personId);
  if (p?.profileId && g.me && g.iFollow.has(p.profileId) && g.followsMe.has(p.profileId)) factors.push({ factor: "frame", text: "You follow each other on Frame", weight: 1, evidenceIds: rels.filter((r) => r.source === "frame_follow").map((r) => r.evidenceId) });
  const score = factors.reduce((n, f) => n + f.weight, 0);
  const level = !rels.length ? "none" : score >= 5 ? "strong" : score >= 2 ? "medium" : factors.length ? "weak" : "unknown";
  return { level: level as "strong" | "medium" | "weak" | "unknown" | "none", score, factors, lastInteractionAt: talks[0]?.occurredAt ?? null };
}
export const Strength = s.object({ level: s.enum(["strong", "medium", "weak", "unknown", "none"]), score: s.number(), factors: s.array(Reason), lastInteractionAt: s.nullable(s.number()) });

// ------------------------------------------------------------------------------------------ cards

export const Position = s.object({ id: s.string(), title: s.string(), organizationId: s.string(), organization: s.string(), seniority: s.string(), function: s.string(), startDate: s.nullable(s.string()), endDate: s.nullable(s.string()), current: s.boolean(), evidenceId: s.string() });
export const position = (g: Graph, j: Emp) => ({ id: j.id, title: j.title, organizationId: j.organizationId, organization: orgName(g, j.organizationId), seniority: j.seniority, function: j.function, startDate: j.startDate ?? null, endDate: j.endDate ?? null, current: j.current, evidenceId: j.evidenceId });

export const HowKnown = s.object({ type: s.string(), source: s.string(), establishedAt: s.nullable(s.string()), closeness: s.nullable(s.integer()), context: s.nullable(s.string()), evidenceId: s.string() });

export const PersonCard = s.object({
  id: s.string(),
  displayName: s.string(),
  headline: s.nullable(s.string()),
  location: s.nullable(s.string()),
  profileId: s.nullable(s.string()),
  current: s.array(Position),
  pastCount: s.integer(),
  domains: s.array(s.string()),
  skills: s.array(s.string()),
  /** direct | historical (established), suggested (an inference), none (someone the owner knows of). */
  relationship: s.enum(["direct", "historical", "suggested", "none"]),
  howKnown: s.array(HowKnown),
  strength: Strength,
});

export function card(g: Graph, p: PersonDoc) {
  const rels = g.rels.get(p.id) ?? [];
  const est = knows(g, p.id);
  return {
    id: p.id, displayName: p.displayName, headline: p.headline ?? null, location: p.location ?? null, profileId: p.profileId ?? null,
    current: currentJobs(g, p.id).map((j) => position(g, j)), pastCount: pastJobs(g, p.id).length,
    domains: [...personDomains(g, p).keys()], skills: (g.skills.get(p.id) ?? []).map((k) => k.skill),
    relationship: (est.some((r) => r.type === "direct") ? "direct" : est.length ? "historical" : rels.length ? "suggested" : "none") as "direct" | "historical" | "suggested" | "none",
    howKnown: rels.map((r) => ({ type: r.type, source: r.source, establishedAt: r.establishedAt ?? null, closeness: r.closeness ?? null, context: r.context ?? null, evidenceId: r.evidenceId })),
    strength: strength(g, p.id),
  };
}

// ---------------------------------------------------------------------------------------- filters

export interface Filter {
  text?: string;
  organizationIds?: string[];
  functions?: string[];
  seniority?: string[];
  domains?: string[];
  skills?: string[];
  relationship?: "established" | "direct" | "historical" | "any";
  includePast?: boolean;
}

/** Whether a person matches every filter given, and the reasons (with evidence) they do. */
export function matches(g: Graph, p: PersonDoc, f: Filter): ReasonT[] | null {
  const reasons: ReasonT[] = [];
  const jobs = f.includePast ? g.jobs.get(p.id) ?? [] : currentJobs(g, p.id);
  const rel = f.relationship ?? "established";
  const est = knows(g, p.id);
  if (rel === "established" && !est.length) return null;
  if ((rel === "direct" || rel === "historical") && !est.some((r) => r.type === rel)) return null;
  if (f.organizationIds?.length) {
    const j = jobs.find((x) => f.organizationIds!.includes(x.organizationId));
    if (!j) return null;
    reasons.push({ factor: "organization", text: `${j.current ? "" : "Formerly "}${jobText(g, j)}`, weight: 0, evidenceIds: [j.evidenceId] });
  }
  if (f.functions?.length) {
    const j = jobs.find((x) => f.functions!.includes(x.function) || (f.functions!.includes("executive") && LEADERSHIP.has(x.seniority)));
    if (!j) return null;
    reasons.push({ factor: "function", text: `${j.current ? "" : "Formerly "}${jobText(g, j)} (${j.function})`, weight: 0, evidenceIds: [j.evidenceId] });
  }
  if (f.seniority?.length) {
    const j = jobs.find((x) => f.seniority!.includes(x.seniority));
    if (!j) return null;
    reasons.push({ factor: "seniority", text: `${j.seniority.toUpperCase() === "CXO" ? "C-level" : j.seniority}: ${jobText(g, j)}`, weight: 0, evidenceIds: [j.evidenceId] });
  }
  if (f.domains?.length) {
    const ds = personDomains(g, p);
    const hit = f.domains.map((d) => ds.get(d)).find(Boolean);
    if (!hit) return null;
    reasons.push(hit);
  }
  if (f.skills?.length) {
    const have = g.skills.get(p.id) ?? [];
    const exact = have.find((k) => f.skills!.includes(k.skill));
    // Otherwise a recorded skill in the same recognized domain ("cybersecurity" ~ "security"), said as such.
    const related = exact ? null : f.skills.map((q) => ({ q, hit: have.find((k) => domainsIn(k.skill).some((d) => domainsIn(q).includes(d))) })).find((x) => x.hit);
    const hit = exact ?? related?.hit;
    if (!hit) return null;
    reasons.push({ factor: "skill", text: exact ? `Skill: ${hit.skill}` : `Skill: ${hit.skill} (related to “${related!.q}”)`, weight: 0, evidenceIds: [hit.evidenceId] });
  }
  if (f.text?.trim()) {
    const q = f.text.trim().toLowerCase();
    const hay = [p.displayName, p.headline ?? "", ...jobs.map((j) => `${j.title} ${orgName(g, j.organizationId)}`), ...(g.skills.get(p.id) ?? []).map((k) => k.skill)].join(" • ").toLowerCase();
    if (!q.split(/\s+/).every((w) => hay.includes(w))) return null;
    reasons.push({ factor: "text", text: `Matches “${f.text.trim()}”`, weight: 0, evidenceIds: [] });
  }
  return reasons;
}

// ------------------------------------------------------------------------------------- relevance

export const FRESH_FOR = 60 * DAY;

export interface Hiring { organizationId: string; evidence: Doc<typeof evidence.shape> }

/** Active hiring evidence per organization: not superseded, not disputed, not past its validity. */
export async function hiringSignals(db: DatabaseReader, ownerId: string, now = Date.now(), includeStale = false) {
  const all = await db.find(evidence, { ownerId, predicate: "hiring" });
  const out = new Map<string, Array<Doc<typeof evidence.shape>>>();
  for (const e of all) {
    if (e.subjectType !== "organization" || e.verification === "superseded" || e.verification === "disputed") continue;
    if (!includeStale && (e.validUntil ?? e.observedAt + FRESH_FOR) < now) continue;
    push(out, e.subjectId, e);
  }
  return out;
}

/**
 * How relevant a person in the owner's network is to the owner's goal, as explainable factors with
 * evidence. Relevance needs at least one factor about the goal itself (role, domain, organization or
 * hiring); relationship strength only orders people who are already relevant.
 */
export function relevance(g: Graph, p: PersonDoc, goal: Pick<Goal, "functions" | "domains" | "seniority" | "organizationIds">, hiring: Map<string, Array<Doc<typeof evidence.shape>>>) {
  const reasons: ReasonT[] = [];
  const cur = currentJobs(g, p.id);
  const fn = cur.find((j) => goal.functions.includes(j.function));
  if (fn) reasons.push({ factor: "role", text: `Works in ${fn.function}: ${jobText(g, fn)}`, weight: 3, evidenceIds: [fn.evidenceId] });
  const lead = cur.find((j) => LEADERSHIP.has(j.seniority) && (goal.functions.includes(j.function) || j.function === "executive" || j.function === "people"));
  if (lead && (goal.seniority.length === 0 || goal.seniority.some((s) => LEADERSHIP.has(s)))) reasons.push({ factor: "leadership", text: `Senior enough to hire or refer (${lead.seniority}): ${jobText(g, lead)}`, weight: 2, evidenceIds: [lead.evidenceId] });
  const ds = personDomains(g, p);
  const dom = goal.domains.map((d) => ds.get(d)).filter(Boolean) as ReasonT[];
  if (dom.length) reasons.push({ ...dom[0]!, factor: "domain", text: `In ${dom[0]!.text}`, weight: 3 });
  const atGoalOrg = cur.find((j) => goal.organizationIds.includes(j.organizationId));
  if (atGoalOrg) reasons.push({ factor: "organization", text: `At a company you're targeting: ${jobText(g, atGoalOrg)}`, weight: 3, evidenceIds: [atGoalOrg.evidenceId] });
  for (const j of cur) {
    const signals = hiring.get(j.organizationId);
    if (!signals?.length) continue;
    const e = signals.sort((a, b) => b.observedAt - a.observedAt)[0]!;
    reasons.push({ factor: "hiring", text: `${orgName(g, j.organizationId)} is hiring: ${e.objectValue} (${e.kind.replace("_", " ")}, ${new Date(e.observedAt).toISOString().slice(0, 10)})`, weight: 4, evidenceIds: [e.id, j.evidenceId] });
    break;
  }
  const past = pastJobs(g, p.id).find((j) => goal.functions.includes(j.function) || goal.domains.some((d) => domainsIn(`${j.title} ${orgName(g, j.organizationId)}`).includes(d)));
  if (past && !fn && !dom.length) reasons.push({ factor: "past", text: `Previously ${jobText(g, past)}`, weight: 1, evidenceIds: [past.evidenceId] });
  // Someone they know (by the owner's own records) is at a hiring or goal organization.
  for (const n of g.neighbors.get(p.id) ?? []) {
    const nj = currentJobs(g, n.personId).find((j) => hiring.has(j.organizationId) || goal.organizationIds.includes(j.organizationId));
    if (nj) {
      reasons.push({ factor: "introduction", text: `Knows ${g.people.get(n.personId)?.displayName} (${jobText(g, nj)})`, weight: 2, evidenceIds: [n.tie.evidenceId, nj.evidenceId] });
      break;
    }
  }
  const relevant = reasons.some((r) => ["role", "domain", "organization", "hiring", "past", "introduction"].includes(r.factor));
  const st = strength(g, p.id);
  if (relevant && (st.level === "strong" || st.level === "medium")) reasons.push({ factor: "strength", text: `You know them well (${st.level}): ${st.factors.map((f) => f.text).join("; ")}`, weight: st.level === "strong" ? 2 : 1, evidenceIds: st.factors.flatMap((f) => f.evidenceIds) });
  return { relevant, score: reasons.reduce((n, r) => n + r.weight, 0), reasons, strength: st };
}

/** Limitations Frame states instead of guessing. */
export function limitations(g: Graph, p: PersonDoc): string[] {
  const out: string[] = [];
  if (!(g.talks.get(p.id) ?? []).length) out.push("No interactions recorded: how well you know them is unknown beyond the connection itself.");
  const cur = currentJobs(g, p.id);
  if (!cur.length) out.push("No current position on record.");
  const newest = Math.max(0, ...cur.map((j) => dateMs(j.startDate)).filter((n) => !Number.isNaN(n)));
  if (cur.length && !newest) out.push("Position start date unknown.");
  return out;
}
