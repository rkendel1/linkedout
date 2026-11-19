/**
 * The owner's professional network: importing authorized connection data, resolving people,
 * searching, the full person record with its evidence and history, and the owner's corrections.
 *
 * Entity resolution is deterministic and conservative: a strong identifier (LinkedIn URL, e-mail,
 * Frame profile) matches; the same name at the same current organization matches; a name alone never
 * merges two records. Possible duplicates are listed for the owner to reconcile (`network.merge`).
 */
import { fail, s, type Doc, type MutationCtx } from "@feltdb/feltkit";
import { app, employments, evidence, identifiers, imports, interactions, ledger, organizations, people, personSkills, relationships, ties, drafts, followups, profiles, FUNCTIONS, SENIORITY } from "./app.js";
import {
  DAY, DOMAIN_NAMES, addEvidence, connectionRows, orgKey, emailKey, functionOf, history, isoDate, linkedinKey, nameKey, organizationNamed, ownPerson, ownerOf, seniorityOf, sha256, skillKey,
  type ConnectionRow, type PersonDoc, type SourceType, type EvidenceKind,
} from "./_network.js";
import { HowKnown, PersonCard, Position, Reason, Strength, card, limitations, loadGraph, matches, position, strength } from "./_graph.js";
import { Author, author } from "./_frame.js";

const MAX_ROWS = 1500;
const personOwns = { collection: people, id: "personId", field: "ownerId" } as const;

// ------------------------------------------------------------------------------------- resolution

type Source = { sourceType: SourceType; sourceReference: string; kind: EvidenceKind; observedAt: number };

async function byIdentifier(ctx: Pick<MutationCtx, "db">, ownerId: string, kind: "email" | "linkedin" | "frame", value: string) {
  const [hit] = await ctx.db.find(identifiers, { ownerId, kind, value });
  if (!hit) return null;
  const p = await ctx.db.get(people, hit.personId);
  if (p?.status === "merged" && p.mergedInto) return ctx.db.get(people, p.mergedInto);
  return p;
}

/** Attach an identifier to a person once (FeltDB's unique constraint makes a second owner of it impossible). */
async function identify(ctx: Pick<MutationCtx, "db">, ownerId: string, personId: string, kind: "email" | "linkedin" | "frame", value: string, src: Source) {
  const [hit] = await ctx.db.find(identifiers, { ownerId, kind, value });
  if (hit) return hit.personId === personId;
  const ev = await addEvidence(ctx, ownerId, { subjectType: "person", subjectId: personId, predicate: kind, objectValue: value, confidence: 0.95, ...src });
  await ctx.db.insert(identifiers, { ownerId, personId, kind, value, evidenceId: ev.id, createdAt: Date.now() });
  return true;
}

/**
 * Find the person a row describes, or null. Order: LinkedIn URL, e-mail, then the same name at the
 * same current organization. The match and its basis are returned so the import can say why.
 */
async function resolve(ctx: Pick<MutationCtx, "db">, ownerId: string, row: { name: string; email?: string | null; linkedin?: string | null; company?: string }) {
  if (row.linkedin) {
    const p = await byIdentifier(ctx, ownerId, "linkedin", row.linkedin);
    if (p) return { person: p, basis: "linkedin" };
  }
  if (row.email) {
    const p = await byIdentifier(ctx, ownerId, "email", row.email);
    if (p) return { person: p, basis: "email" };
  }
  const key = nameKey(row.name);
  if (key && row.company) {
    const [org] = await ctx.db.find(organizations, { ownerId, nameKey: orgKey(row.company) });
    if (org) {
      for (const p of await ctx.db.find(people, { ownerId, nameKey: key })) {
        if (p.status !== "active") continue;
        const jobs = await ctx.db.find(employments, { ownerId, personId: p.id });
        if (jobs.some((j) => j.current && j.organizationId === org.id)) return { person: p, basis: "name+organization" };
      }
    }
  }
  return null;
}

/**
 * Record that a person holds `title` at `organization` as of `src.observedAt`. History is kept: the
 * same position again is corroboration (no new record); a different title or organization starts a
 * new current position and ends the previous one, citing the evidence that ended it.
 */
export async function observePosition(ctx: MutationCtx, ownerId: string, personId: string, input: { organization: string; title: string; industry?: string; startDate?: string; endDate?: string; current: boolean }, src: Source) {
  const organizationId = await organizationNamed(ctx, ownerId, input.organization, src, input.industry ? { industry: input.industry } : {});
  const title = input.title.trim().slice(0, 200);
  const ev = await addEvidence(ctx, ownerId, {
    subjectType: "person", subjectId: personId, predicate: input.current ? "works_at" : "worked_at",
    objectValue: `${title || "(no title)"} at ${input.organization.trim()}${input.startDate ? ` from ${input.startDate}` : ""}${input.endDate ? ` to ${input.endDate}` : ""}`,
    confidence: src.kind === "user_provided" ? 1 : 0.9, ...src,
  });
  const jobs = await ctx.db.find(employments, { ownerId, personId });
  const same = jobs.find((j) => j.organizationId === organizationId && j.title.toLowerCase() === title.toLowerCase() && (j.current === input.current || !input.current));
  if (same) return { employmentId: same.id, changed: false, evidenceId: ev.id };
  if (input.current) {
    for (const j of jobs.filter((j) => j.current)) {
      await ctx.db.patch(employments, j.id, { current: false, endedByEvidenceId: ev.id, ...(input.startDate && !j.endDate ? { endDate: input.startDate } : {}) });
    }
  }
  const employmentId = await ctx.db.insert(employments, {
    ownerId, personId, organizationId, title, seniority: seniorityOf(title), function: functionOf(title), current: input.current, evidenceId: ev.id, createdAt: Date.now(),
    ...(input.startDate ? { startDate: input.startDate } : {}), ...(input.endDate ? { endDate: input.endDate } : {}),
  });
  await history(ctx, personId, input.current ? "position.observed" : "position.recorded", { employmentId, organizationId, title, evidenceId: ev.id, source: src.sourceType });
  return { employmentId, changed: true, evidenceId: ev.id };
}

async function addSkill(ctx: MutationCtx, ownerId: string, personId: string, raw: string, src: Source) {
  const skill = skillKey(raw);
  if (!skill) return;
  const [has] = await ctx.db.find(personSkills, { ownerId, personId, skill });
  if (has) return;
  const ev = await addEvidence(ctx, ownerId, { subjectType: "person", subjectId: personId, predicate: "skill", objectValue: skill, confidence: src.kind === "user_provided" ? 1 : 0.7, ...src });
  await ctx.db.insert(personSkills, { ownerId, personId, skill, evidenceId: ev.id, confidence: src.kind === "user_provided" ? 1 : 0.7, createdAt: Date.now() });
}

/** The owner's relationship with a person from one source, created once. */
export async function relate(ctx: MutationCtx, ownerId: string, personId: string, input: { type: "direct" | "historical" | "suggested"; establishedAt?: string | null; context?: string; closeness?: number; sourceRecordId?: string }, src: Source) {
  const [has] = await ctx.db.find(relationships, { ownerId, personId, source: src.sourceType });
  if (has) return has.id;
  const ev = await addEvidence(ctx, ownerId, {
    subjectType: "person", subjectId: personId, predicate: input.type === "historical" ? "worked_with" : input.type === "suggested" ? "may_know" : "knows",
    objectValue: input.context ?? `${src.sourceType}${input.establishedAt ? ` since ${input.establishedAt}` : ""}`, confidence: input.type === "suggested" ? 0.4 : 0.95, ...src,
  });
  const now = Date.now();
  const id = await ctx.db.insert(relationships, {
    ownerId, personId, type: input.type, source: src.sourceType, status: "active", confidence: input.type === "suggested" ? 0.4 : 0.95, evidenceId: ev.id, createdAt: now, updatedAt: now,
    ...(input.establishedAt ? { establishedAt: input.establishedAt } : {}), ...(input.context ? { context: input.context.slice(0, 500) } : {}),
    ...(input.closeness ? { closeness: input.closeness } : {}), ...(input.sourceRecordId ? { sourceRecordId: input.sourceRecordId } : {}),
  });
  await history(ctx, personId, "relationship.recorded", { relationshipId: id, type: input.type, source: src.sourceType });
  return id;
}

export async function createPerson(ctx: MutationCtx, ownerId: string, input: { displayName: string; headline?: string; location?: string; profileId?: string }, src: Source) {
  const now = Date.now();
  const id = await ctx.db.insert(people, {
    ownerId, displayName: input.displayName.trim().slice(0, 120), nameKey: nameKey(input.displayName), status: "active", createdAt: now, updatedAt: now,
    ...(input.headline ? { headline: input.headline.slice(0, 300) } : {}), ...(input.location ? { location: input.location.slice(0, 120) } : {}), ...(input.profileId ? { profileId: input.profileId } : {}),
  });
  await addEvidence(ctx, ownerId, { subjectType: "person", subjectId: id, predicate: "name", objectValue: input.displayName.trim(), confidence: 0.95, ...src });
  if (input.headline) await addEvidence(ctx, ownerId, { subjectType: "person", subjectId: id, predicate: "headline", objectValue: input.headline, confidence: 0.8, ...src });
  await history(ctx, id, "person.created", { source: src.sourceType, reference: src.sourceReference });
  return id;
}

// ------------------------------------------------------------------------------------------ import

const ImportResult = s.object({ importId: s.string(), source: s.string(), rows: s.integer(), created: s.integer(), matched: s.integer(), skipped: s.array(s.object({ row: s.integer(), reason: s.string() })), replayed: s.boolean() });

export const importConnections = app.mutation({
    access: "network.write",
    args: { fileName: s.string({ minLength: 1, maxLength: 200 }), csv: s.string({ maxLength: 3_000_000 }) },
    returns: ImportResult,
    capability: {
      name: "network.import",
      description: "Import an authorized connection list into the caller's network: LinkedIn's Connections.csv export (as downloaded) or any CSV with Name/First Name+Last Name and optional Email, URL, Company, Position, Connected On, Skills, Location, Notes. The same file twice is one import. Every imported fact gets provenance.",
    },
    handler: async (ctx, { fileName, csv }) => {
      const ownerId = ownerOf(ctx);
      const contentHash = await sha256(csv);
      const [prior] = await ctx.db.find(imports, { ownerId, contentHash });
      if (prior) return { importId: prior.id, source: prior.source, rows: prior.rows, created: prior.created, matched: prior.matched, skipped: prior.skipped, replayed: true };
      const { source, rows } = connectionRows(csv);
      if (rows.length > MAX_ROWS) fail("INVALID_ARGUMENT", `This file has ${rows.length} rows; import at most ${MAX_ROWS} at a time (split the file; rows already imported are recognised).`);
      const now = Date.now();
      const importId = await ctx.db.insert(imports, { ownerId, source, fileName, contentHash, rows: rows.length, created: 0, matched: 0, skipped: [], createdAt: now });
      const src: Source = { sourceType: source, sourceReference: importId, kind: "imported", observedAt: now };
      let created = 0, matched = 0;
      const skipped: Array<{ row: number; reason: string }> = [];
      for (const r of rows) {
        const res = await importRow(ctx, ownerId, r, src);
        if (res === "created") created++;
        else if (res === "matched") matched++;
        else if (skipped.length < 200) skipped.push({ row: r.row, reason: res.skip });
      }
      await ctx.db.patch(imports, importId, { created, matched, skipped });
      return { importId, source, rows: rows.length, created, matched, skipped, replayed: false };
  },
});

async function importRow(ctx: MutationCtx, ownerId: string, r: ConnectionRow, src: Source): Promise<"created" | "matched" | { skip: string }> {
  const name = (r.name ?? [r.first, r.last].filter(Boolean).join(" ")).trim();
  if (!name || !nameKey(name)) return { skip: "no name" };
  const email = r.email ? emailKey(r.email) : null;
  const linkedin = r.linkedin ? linkedinKey(r.linkedin) : null;
  const found = await resolve(ctx, ownerId, { name, email, linkedin, ...(r.company ? { company: r.company } : {}) });
  const personId = found?.person?.id ?? (await createPerson(ctx, ownerId, { displayName: name, ...(r.headline ? { headline: r.headline } : {}), ...(r.location ? { location: r.location } : {}) }, src));
  if (found?.person) await history(ctx, personId, "person.matched", { basis: found.basis, importId: src.sourceReference });
  if (linkedin) await identify(ctx, ownerId, personId, "linkedin", linkedin, src);
  if (email) await identify(ctx, ownerId, personId, "email", email, src);
  const connectedOn = isoDate(r.connectedOn);
  await relate(ctx, ownerId, personId, { type: "direct", establishedAt: connectedOn, ...(r.notes ? { context: r.notes } : {}) }, src);
  if (r.company) await observePosition(ctx, ownerId, personId, { organization: r.company, title: r.title ?? "", current: true, ...(r.industry ? { industry: r.industry } : {}) }, src);
  else if (r.industry) {
    // An industry without a company describes where they work now.
    for (const j of (await ctx.db.find(employments, { ownerId, personId })).filter((x) => x.current)) {
      const org = await ctx.db.get(organizations, j.organizationId);
      if (!org || org.industry) continue;
      await ctx.db.patch(organizations, org.id, { industry: r.industry.slice(0, 120) });
      await addEvidence(ctx, ownerId, { subjectType: "organization", subjectId: org.id, predicate: "industry", objectValue: r.industry, confidence: 0.8, ...src });
    }
  }
  for (const k of (r.skills ?? "").split(/[;|,]/)) if (k.trim()) await addSkill(ctx, ownerId, personId, k, src);
  return found?.person ? "matched" : "created";
}

export const importsList = app.query({
  access: "network.read",
  returns: s.array(s.object({ id: s.string(), source: s.string(), fileName: s.string(), rows: s.integer(), created: s.integer(), matched: s.integer(), skipped: s.integer(), createdAt: s.number() })),
  capability: { name: "network.imports", description: "The caller's imports, newest first: what each file added, matched and skipped." },
  handler: async (ctx) => {
    const list = await ctx.db.find(imports, { ownerId: ownerOf(ctx) }, { orderBy: [{ field: "createdAt", direction: "desc" }], limit: 50 });
    return list.map((i) => ({ id: i.id, source: i.source, fileName: i.fileName, rows: i.rows, created: i.created, matched: i.matched, skipped: i.skipped.length, createdAt: i.createdAt }));
  },
});

// ------------------------------------------------------------------------------------------ search

const RelFilter = s.enum(["established", "direct", "historical", "any"]);
export const SearchArgs = {
  text: s.optional(s.string({ maxLength: 200 })),
  organization: s.optional(s.string({ maxLength: 160 })),
  functions: s.optional(s.array(s.enum(FUNCTIONS), { maxItems: 6 })),
  seniority: s.optional(s.array(s.enum(SENIORITY), { maxItems: 7 })),
  domains: s.optional(s.array(s.enum(DOMAIN_NAMES), { maxItems: 6 })),
  skills: s.optional(s.array(s.string({ maxLength: 60 }), { maxItems: 6 })),
  relationship: s.optional(RelFilter),
  includePast: s.optional(s.boolean()),
  limit: s.optional(s.integer({ minimum: 1, maximum: 200 })),
};
export const SearchResult = s.object({ total: s.integer(), people: s.array(s.object({ person: PersonCard, reasons: s.array(Reason) })), unknownOrganization: s.nullable(s.string()) });

export const search = app.query({
  access: "network.read",
  args: SearchArgs,
  returns: SearchResult,
  capability: {
    name: "network.search",
    description: "Search the caller's professional network by text, organization (current, or past with includePast), function, seniority, domain (ai, infrastructure, fintech, …), skill and relationship (established = direct or historical; any includes people the caller only knows of). Each result says why it matched, with evidence ids.",
  },
  handler: async (ctx, a) => {
    const ownerId = ownerOf(ctx);
    const g = await loadGraph(ctx.db, ownerId);
    let organizationIds: string[] | undefined;
    if (a.organization) {
      const key = orgKey(a.organization);
      organizationIds = [...g.orgs.values()].filter((o) => o.nameKey === key || o.nameKey.startsWith(`${key} `)).map((o) => o.id);
      if (!organizationIds.length) return { total: 0, people: [], unknownOrganization: a.organization };
    }
    const filter = {
      ...(a.text ? { text: a.text } : {}), ...(organizationIds ? { organizationIds } : {}), ...(a.functions ? { functions: a.functions } : {}), ...(a.seniority ? { seniority: a.seniority } : {}),
      ...(a.domains ? { domains: a.domains } : {}), ...(a.skills ? { skills: a.skills.map((k) => skillKey(k) ?? k) } : {}), relationship: a.relationship ?? "established", includePast: a.includePast ?? Boolean(organizationIds),
    } as const;
    const hits: Array<{ p: PersonDoc; reasons: ReturnType<typeof matches> & {} }> = [];
    for (const p of g.people.values()) {
      const r = matches(g, p, filter);
      if (r) hits.push({ p, reasons: r });
    }
    const ranked = hits.map((h) => ({ ...h, st: strength(g, h.p.id) })).sort((x, y) => y.st.score - x.st.score || x.p.displayName.localeCompare(y.p.displayName));
    return { total: ranked.length, people: ranked.slice(0, a.limit ?? 50).map((h) => ({ person: card(g, h.p), reasons: h.reasons })), unknownOrganization: null };
  },
});

// ------------------------------------------------------------------------------------------ person

const EvidenceView = s.object({
  id: s.string(), subjectType: s.string(), subjectId: s.string(), predicate: s.string(), objectValue: s.string(), kind: s.string(), sourceType: s.string(), sourceReference: s.string(),
  sourceUri: s.nullable(s.string()), observedAt: s.number(), capturedAt: s.number(), validUntil: s.nullable(s.number()), confidence: s.number(), verification: s.string(), supersededBy: s.nullable(s.string()),
});
export const evidenceView = (e: Doc<typeof evidence.shape>) => ({
  id: e.id, subjectType: e.subjectType, subjectId: e.subjectId, predicate: e.predicate, objectValue: e.objectValue, kind: e.kind, sourceType: e.sourceType, sourceReference: e.sourceReference,
  sourceUri: e.sourceUri ?? null, observedAt: e.observedAt, capturedAt: e.capturedAt, validUntil: e.validUntil ?? null, confidence: e.confidence, verification: e.verification, supersededBy: e.supersededBy ?? null,
});
export { EvidenceView };

const Known = s.object({ id: s.string(), displayName: s.string(), basis: s.string(), context: s.nullable(s.string()), evidenceId: s.string() });

export const person = app.query({
  access: "network.read",
  args: { personId: s.string() },
  returns: s.object({
    person: PersonCard,
    positions: s.array(Position),
    identifiers: s.array(s.object({ kind: s.string(), value: s.string(), evidenceId: s.string() })),
    knows: s.array(Known),
    interactions: s.array(s.object({ id: s.string(), kind: s.string(), occurredAt: s.number(), note: s.nullable(s.string()), evidenceId: s.string() })),
    evidence: s.array(EvidenceView),
    history: s.array(s.object({ seq: s.number(), type: s.string(), at: s.number(), actor: s.string(), actorType: s.string(), data: s.record(s.unknown()) })),
    possibleDuplicates: s.array(s.object({ id: s.string(), displayName: s.string(), current: s.array(s.string()) })),
    frameProfile: s.nullable(Author),
    limitations: s.array(s.string()),
  }),
  capability: { name: "network.person", description: "One person in the caller's network: positions (current and past), how the caller knows them, who else in the network they know, interactions, every piece of evidence with its source, the record's history, and possible duplicates." },
  handler: async (ctx, { personId }) => {
    const ownerId = ownerOf(ctx);
    const p = await ownPerson(ctx.db, ownerId, personId);
    const g = await loadGraph(ctx.db, ownerId);
    const mergedFrom = await ctx.db.find(people, { ownerId, nameKey: p.nameKey });
    const subjectIds = [p.id, ...mergedFrom.filter((x) => x.mergedInto === p.id).map((x) => x.id)];
    const [ids, evs, hist, prof] = await Promise.all([
      ctx.db.find(identifiers, { ownerId, personId: p.id }),
      Promise.all(subjectIds.map((id) => ctx.db.find(evidence, { ownerId, subjectType: "person", subjectId: id }))).then((x) => x.flat()),
      ledger.history(ctx, "person", p.id),
      p.profileId ? ctx.db.get(profiles, p.profileId) : null,
    ]);
    const dupes = mergedFrom.filter((x) => x.id !== p.id && x.status === "active");
    return {
      person: card(g, p),
      positions: (g.jobs.get(p.id) ?? []).sort((a, b) => Number(b.current) - Number(a.current) || b.createdAt - a.createdAt).map((j) => position(g, j)),
      identifiers: ids.map((i) => ({ kind: i.kind, value: i.value, evidenceId: i.evidenceId })),
      knows: (g.neighbors.get(p.id) ?? []).map((n) => ({ id: n.personId, displayName: g.people.get(n.personId)?.displayName ?? "?", basis: n.tie.basis, context: n.tie.context ?? null, evidenceId: n.tie.evidenceId })),
      interactions: (g.talks.get(p.id) ?? []).map((i) => ({ id: i.id, kind: i.kind, occurredAt: i.occurredAt, note: i.note ?? null, evidenceId: i.evidenceId })),
      evidence: evs.sort((a, b) => b.capturedAt - a.capturedAt).map(evidenceView),
      history: hist.map((h) => ({ seq: h.seq, type: h.type, at: h.at, actor: h.actor, actorType: h.actorType, data: h.data ?? {} })),
      possibleDuplicates: dupes.map((d) => ({ id: d.id, displayName: d.displayName, current: (g.jobs.get(d.id) ?? []).filter((j) => j.current).map((j) => `${j.title} at ${g.orgs.get(j.organizationId)?.name ?? "?"}`) })),
      frameProfile: prof ? author(prof) : null,
      limitations: limitations(g, p),
    };
  },
});

export const duplicates = app.query({
  access: "network.read",
  returns: s.array(s.object({ nameKey: s.string(), people: s.array(s.object({ id: s.string(), displayName: s.string(), current: s.array(s.string()), identifiers: s.array(s.string()) })) })),
  capability: { name: "network.duplicates", description: "Groups of people in the caller's network with the same normalized name that were not merged automatically (a name alone never merges). Reconcile with network.merge." },
  handler: async (ctx) => {
    const ownerId = ownerOf(ctx);
    const g = await loadGraph(ctx.db, ownerId);
    const groups = new Map<string, PersonDoc[]>();
    for (const p of g.people.values()) (groups.get(p.nameKey) ?? groups.set(p.nameKey, []).get(p.nameKey)!).push(p);
    const ids = await ctx.db.find(identifiers, { ownerId });
    return [...groups].filter(([, list]) => list.length > 1).map(([key, list]) => ({
      nameKey: key,
      people: list.map((p) => ({ id: p.id, displayName: p.displayName, current: (g.jobs.get(p.id) ?? []).filter((j) => j.current).map((j) => `${j.title} at ${g.orgs.get(j.organizationId)?.name ?? "?"}`), identifiers: ids.filter((i) => i.personId === p.id).map((i) => `${i.kind}:${i.value}`) })),
    }));
  },
});

export const organizationsList = app.query({
  access: "network.read",
  args: { text: s.optional(s.string({ maxLength: 160 })) },
  returns: s.array(s.object({ id: s.string(), name: s.string(), industry: s.nullable(s.string()), current: s.integer(), former: s.integer() })),
  capability: { name: "organization.search", description: "Organizations in the caller's network, with how many of the caller's people work there now and formerly." },
  handler: async (ctx, { text }) => {
    const ownerId = ownerOf(ctx);
    const orgs = text ? await ctx.db.search(organizations, { text, where: { ownerId }, limit: 100 }) : await ctx.db.find(organizations, { ownerId }, { limit: 500 });
    const jobs = await ctx.db.find(employments, { ownerId });
    return orgs.map((o) => ({ id: o.id, name: o.name, industry: o.industry ?? null, current: jobs.filter((j) => j.organizationId === o.id && j.current).length, former: jobs.filter((j) => j.organizationId === o.id && !j.current).length }))
      .sort((a, b) => b.current - a.current || a.name.localeCompare(b.name));
  },
});

// ------------------------------------------------------------------------------- owner's own word

const userSrc = (ctx: MutationCtx, reference = "user"): Source => ({ sourceType: "user", sourceReference: `${reference}:${ctx.requestId}`.slice(0, 200), kind: "user_provided", observedAt: Date.now() });

export const addPerson = app.mutation({
  access: "network.write",
  args: {
    displayName: s.string({ minLength: 1, maxLength: 120 }),
    organization: s.optional(s.string({ maxLength: 160 })),
    title: s.optional(s.string({ maxLength: 200 })),
    email: s.optional(s.string({ maxLength: 200 })),
    linkedin: s.optional(s.string({ maxLength: 300 })),
    /** How the caller knows them. "none": someone they know of but have no relationship with. */
    relationship: s.enum(["direct", "historical", "none"]),
    context: s.optional(s.string({ maxLength: 500 })),
  },
  returns: s.object({ personId: s.string(), matched: s.boolean() }),
  capability: { name: "network.addperson", description: "Add someone to the caller's network by the caller's own account (user-provided evidence). Matches an existing person by e-mail or LinkedIn URL instead of duplicating them." },
  handler: async (ctx, a) => {
    const ownerId = ownerOf(ctx);
    const src = userSrc(ctx, "addperson");
    const email = a.email ? emailKey(a.email) : null;
    const linkedin = a.linkedin ? linkedinKey(a.linkedin) : null;
    if (a.email && !email) fail("INVALID_ARGUMENT", "That e-mail address is not valid.");
    const found = await resolve(ctx, ownerId, { name: a.displayName, email, linkedin, ...(a.organization ? { company: a.organization } : {}) });
    const personId = found?.person?.id ?? (await createPerson(ctx, ownerId, { displayName: a.displayName }, src));
    if (email) await identify(ctx, ownerId, personId, "email", email, src);
    if (linkedin) await identify(ctx, ownerId, personId, "linkedin", linkedin, src);
    if (a.organization) await observePosition(ctx, ownerId, personId, { organization: a.organization, title: a.title ?? "", current: true }, src);
    if (a.relationship !== "none") await relate(ctx, ownerId, personId, { type: a.relationship, ...(a.context ? { context: a.context } : {}) }, src);
    return { personId, matched: Boolean(found?.person) };
  },
});

export const updatePerson = app.mutation({
  access: "network.write",
  args: { personId: s.string(), displayName: s.optional(s.string({ minLength: 1, maxLength: 120 })), headline: s.optional(s.string({ maxLength: 300 })), location: s.optional(s.string({ maxLength: 120 })) },
  returns: s.object({ evidenceIds: s.array(s.string()) }),
  owner: personOwns,
  capability: { name: "network.updateperson", description: "Correct a person's name, headline or location. The correction is user-provided evidence; earlier evidence is kept." },
  handler: async (ctx, { personId, ...fields }) => {
    const ownerId = ownerOf(ctx);
    const p = await ownPerson(ctx.db, ownerId, personId);
    const src = userSrc(ctx, "correction");
    const evidenceIds: string[] = [];
    const patch: Record<string, string> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      evidenceIds.push((await addEvidence(ctx, ownerId, { subjectType: "person", subjectId: p.id, predicate: k === "displayName" ? "name" : k, objectValue: v, confidence: 1, ...src })).id);
      patch[k] = v;
      if (k === "displayName") patch.nameKey = nameKey(v);
    }
    await ctx.db.patch(people, p.id, { ...patch, updatedAt: Date.now() });
    await history(ctx, p.id, "person.corrected", { fields: Object.keys(patch).join(",") });
    return { evidenceIds };
  },
});

export const addPosition = app.mutation({
  access: "network.write",
  args: { personId: s.string(), organization: s.string({ minLength: 1, maxLength: 160 }), title: s.string({ maxLength: 200 }), startDate: s.optional(s.string({ maxLength: 10 })), endDate: s.optional(s.string({ maxLength: 10 })), current: s.boolean(), industry: s.optional(s.string({ maxLength: 120 })) },
  returns: s.object({ employmentId: s.string(), changed: s.boolean() }),
  owner: personOwns,
  capability: { name: "employment.add", description: "Record a position a person holds or held (user-provided). A current position ends their other current ones; nothing is deleted." },
  handler: async (ctx, a) => {
    const ownerId = ownerOf(ctx);
    const p = await ownPerson(ctx.db, ownerId, a.personId);
    const startDate = a.startDate ? isoDate(a.startDate) ?? fail("INVALID_ARGUMENT", "startDate must be a date (YYYY, YYYY-MM or YYYY-MM-DD).") : undefined;
    const endDate = a.endDate ? isoDate(a.endDate) ?? fail("INVALID_ARGUMENT", "endDate must be a date.") : undefined;
    const r = await observePosition(ctx, ownerId, p.id, { organization: a.organization, title: a.title, current: a.current, ...(startDate ? { startDate } : {}), ...(endDate ? { endDate } : {}), ...(a.industry ? { industry: a.industry } : {}) }, userSrc(ctx, "position"));
    return { employmentId: r.employmentId, changed: r.changed };
  },
});

export const endPosition = app.mutation({
  access: "network.write",
  args: { employmentId: s.string(), endDate: s.optional(s.string({ maxLength: 10 })) },
  returns: s.object({ evidenceId: s.string() }),
  owner: { collection: employments, id: "employmentId", field: "ownerId" },
  capability: { name: "employment.end", description: "Record that a position ended (the person left). The position stays in their history." },
  handler: async (ctx, { employmentId, endDate }) => {
    const ownerId = ownerOf(ctx);
    const j = (await ctx.db.get(employments, employmentId))!;
    const org = await ctx.db.get(organizations, j.organizationId);
    const ev = await addEvidence(ctx, ownerId, { subjectType: "employment", subjectId: j.id, predicate: "ended", objectValue: `${j.title} at ${org?.name ?? "?"} ended${endDate ? ` ${endDate}` : ""}`, confidence: 1, ...userSrc(ctx, "end") });
    await ctx.db.patch(employments, j.id, { current: false, endedByEvidenceId: ev.id, ...(endDate ? { endDate: isoDate(endDate) ?? endDate } : {}) });
    await history(ctx, j.personId, "position.ended", { employmentId: j.id, evidenceId: ev.id });
    return { evidenceId: ev.id };
  },
});

export const addSkillTo = app.mutation({
  access: "network.write",
  args: { personId: s.string(), skill: s.string({ minLength: 1, maxLength: 60 }) },
  returns: s.object({ skill: s.string() }),
  owner: personOwns,
  capability: { name: "network.addskill", description: "Record a skill or area of expertise for a person (user-provided)." },
  handler: async (ctx, { personId, skill }) => {
    const ownerId = ownerOf(ctx);
    const p = await ownPerson(ctx.db, ownerId, personId);
    const k = skillKey(skill) ?? fail("INVALID_ARGUMENT", "That is not a skill name.");
    await addSkill(ctx, ownerId, p.id, k, userSrc(ctx, "skill"));
    return { skill: k };
  },
});

export const setRelationship = app.mutation({
  access: "network.write",
  args: { personId: s.string(), type: s.optional(s.enum(["direct", "historical"])), closeness: s.optional(s.integer({ minimum: 1, maximum: 5 })), context: s.optional(s.string({ maxLength: 500 })) },
  returns: s.object({ relationshipId: s.string() }),
  owner: personOwns,
  capability: { name: "network.setrelationship", description: "The caller's own account of how they know someone: direct or historical (worked together), how close (1–5), and in their words. Stored as the caller's relationship; imported ones are kept beside it." },
  handler: async (ctx, a) => {
    const ownerId = ownerOf(ctx);
    const p = await ownPerson(ctx.db, ownerId, a.personId);
    const src = userSrc(ctx, "relationship");
    const [mine] = await ctx.db.find(relationships, { ownerId, personId: p.id, source: "user" });
    if (!mine) return { relationshipId: await relate(ctx, ownerId, p.id, { type: a.type ?? "direct", ...(a.context ? { context: a.context } : {}), ...(a.closeness ? { closeness: a.closeness } : {}) }, src) };
    const ev = await addEvidence(ctx, ownerId, { subjectType: "relationship", subjectId: mine.id, predicate: "assessed", objectValue: JSON.stringify({ type: a.type, closeness: a.closeness, context: a.context }), confidence: 1, ...src });
    await ctx.db.patch(relationships, mine.id, { ...(a.type ? { type: a.type } : {}), ...(a.closeness ? { closeness: a.closeness } : {}), ...(a.context !== undefined ? { context: a.context } : {}), evidenceId: ev.id, status: "active", updatedAt: Date.now() });
    await history(ctx, p.id, "relationship.assessed", { relationshipId: mine.id, evidenceId: ev.id, previousEvidenceId: mine.evidenceId });
    return { relationshipId: mine.id };
  },
});

export const addTie = app.mutation({
  access: "network.write",
  args: { personId: s.string(), otherId: s.string(), context: s.optional(s.string({ maxLength: 300 })) },
  returns: s.object({ tieId: s.string() }),
  owner: personOwns,
  capability: { name: "network.addtie", description: "Record, on the caller's word, that two people in their network know each other. Introduction paths use only ties like this (and mutual Frame follows), never shared employers." },
  handler: async (ctx, { personId, otherId, context }) => {
    const ownerId = ownerOf(ctx);
    const [a, b] = [await ownPerson(ctx.db, ownerId, personId), await ownPerson(ctx.db, ownerId, otherId)];
    if (a.id === b.id) fail("INVALID_ARGUMENT", "A person cannot be tied to themselves.");
    const [aId, bId] = [a.id, b.id].sort() as [string, string];
    const [has] = await ctx.db.find(ties, { ownerId, aId, bId });
    if (has) return { tieId: has.id };
    const ev = await addEvidence(ctx, ownerId, { subjectType: "person", subjectId: aId, predicate: "knows_person", objectValue: `${a.displayName} knows ${b.displayName}${context ? `: ${context}` : ""}`, confidence: 1, ...userSrc(ctx, "tie") });
    const tieId = await ctx.db.insert(ties, { ownerId, aId, bId, basis: "user_provided", evidenceId: ev.id, createdAt: Date.now(), ...(context ? { context } : {}) });
    await history(ctx, a.id, "tie.recorded", { tieId, other: b.id });
    await history(ctx, b.id, "tie.recorded", { tieId, other: a.id });
    return { tieId };
  },
});

export const linkProfile = app.mutation({
  access: "network.write",
  args: { personId: s.string(), username: s.string({ maxLength: 30 }) },
  returns: s.object({ profile: Author }),
  owner: personOwns,
  capability: { name: "network.linkprofile", description: "Say that a person in the caller's network is a given Frame profile, so Frame's public activity (posts, follows) informs their record. Only the caller's word links them; names alone never do." },
  handler: async (ctx, { personId, username }) => {
    const ownerId = ownerOf(ctx);
    const p = await ownPerson(ctx.db, ownerId, personId);
    const [prof] = await ctx.db.find(profiles, { username: username.replace(/^@/, "").toLowerCase() });
    if (!prof || prof.kind !== "person") fail("NOT_FOUND", "No person on Frame has that username.");
    const ok = await identify(ctx, ownerId, p.id, "frame", prof!.id, userSrc(ctx, "link"));
    if (!ok) fail("FAILED_PRECONDITION", "That Frame profile is already linked to another person in your network. Merge them instead.");
    await ctx.db.patch(people, p.id, { profileId: prof!.id, updatedAt: Date.now() });
    await history(ctx, p.id, "profile.linked", { profileId: prof!.id });
    return { profile: author(prof!) };
  },
});

export const recordInteraction = app.mutation({
  access: "network.write",
  args: { personId: s.string(), kind: s.enum(["meeting", "call", "email", "message", "introduction", "other"]), occurredAt: s.optional(s.number()), note: s.optional(s.string({ maxLength: 1000 })) },
  returns: s.object({ interactionId: s.string(), evidenceId: s.string() }),
  owner: personOwns,
  capability: { name: "interaction.record", description: "Record something that actually happened with a person (a meeting, call, e-mail, introduction). This is what relationship strength and reconnection are computed from." },
  handler: async (ctx, a) => {
    const ownerId = ownerOf(ctx);
    const p = await ownPerson(ctx.db, ownerId, a.personId);
    const at = a.occurredAt ?? Date.now();
    if (at > Date.now() + DAY) fail("INVALID_ARGUMENT", "An interaction is something that happened; schedule a follow-up for the future.");
    const id = await insertInteraction(ctx, ownerId, p.id, { kind: a.kind, occurredAt: at, ...(a.note ? { note: a.note } : {}), source: "user" });
    return id;
  },
});

export async function insertInteraction(ctx: MutationCtx, ownerId: string, personId: string, i: { kind: Doc<typeof interactions.shape>["kind"]; occurredAt: number; note?: string; source: "user" | "draft" }) {
  const ev = await addEvidence(ctx, ownerId, { subjectType: "person", subjectId: personId, predicate: "interacted", objectValue: `${i.kind}${i.note ? `: ${i.note}` : ""}`, confidence: 1, sourceType: "user", sourceReference: `interaction:${ctx.requestId}`, kind: "user_provided", observedAt: i.occurredAt });
  const interactionId = await ctx.db.insert(interactions, { ownerId, personId, ...i, evidenceId: ev.id, createdAt: Date.now() });
  await history(ctx, personId, "interaction.recorded", { interactionId, kind: i.kind });
  return { interactionId, evidenceId: ev.id };
}

// ----------------------------------------------------------------------------------------- merge

/**
 * Reconcile two records of the same person. Everything about `mergeId` moves to `keepId`; the merged
 * record stays (status "merged", pointing at the survivor) so evidence about it still resolves.
 * An agent can propose this; a person approves it.
 */
export const merge = app.mutation({
  access: "network.write",
  approval: "required",
  args: { keepId: s.string(), mergeId: s.string() },
  returns: s.object({ keepId: s.string(), moved: s.integer() }),
  capability: { name: "network.merge", description: "Merge two records of the same person in the caller's network into one (keepId survives). Needs a person's approval when an agent proposes it." },
  handler: async (ctx, { keepId, mergeId }) => {
    const ownerId = ownerOf(ctx);
    const keep = await ownPerson(ctx.db, ownerId, keepId);
    const gone = await ownPerson(ctx.db, ownerId, mergeId);
    if (keep.id === gone.id) fail("INVALID_ARGUMENT", "Those are the same record.");
    let moved = 0;
    const move = async <C extends typeof identifiers | typeof employments | typeof personSkills | typeof interactions | typeof drafts | typeof followups>(c: C) => {
      for (const r of await ctx.db.find(c as typeof identifiers, { ownerId, personId: gone.id })) {
        await ctx.db.patch(c as typeof identifiers, r.id, { personId: keep.id });
        moved++;
      }
    };
    for (const c of [identifiers, employments, interactions, drafts, followups] as const) await move(c);
    // Skills and relationships are unique per person: keep one of each.
    for (const k of await ctx.db.find(personSkills, { ownerId, personId: gone.id })) {
      const [dupe] = await ctx.db.find(personSkills, { ownerId, personId: keep.id, skill: k.skill });
      if (dupe) await ctx.db.delete(personSkills, k.id);
      else await ctx.db.patch(personSkills, k.id, { personId: keep.id });
      moved++;
    }
    for (const r of await ctx.db.find(relationships, { ownerId, personId: gone.id })) {
      const [dupe] = await ctx.db.find(relationships, { ownerId, personId: keep.id, source: r.source });
      if (dupe) await ctx.db.patch(relationships, r.id, { status: "ended", updatedAt: Date.now() });
      else await ctx.db.patch(relationships, r.id, { personId: keep.id, updatedAt: Date.now() });
      moved++;
    }
    for (const side of ["aId", "bId"] as const) {
      for (const t of await ctx.db.find(ties, { ownerId, [side]: gone.id } as { ownerId: string; aId: string })) {
        const other = side === "aId" ? t.bId : t.aId;
        await ctx.db.delete(ties, t.id);
        if (other === keep.id) continue;
        const [aId, bId] = [keep.id, other].sort() as [string, string];
        const [dupe] = await ctx.db.find(ties, { ownerId, aId, bId });
        if (!dupe) await ctx.db.insert(ties, { ownerId, aId, bId, basis: t.basis, evidenceId: t.evidenceId, createdAt: t.createdAt, ...(t.context ? { context: t.context } : {}) });
        moved++;
      }
    }
    // Two current positions at the same organization with the same title are one.
    const current = (await ctx.db.find(employments, { ownerId, personId: keep.id })).filter((j) => j.current).sort((a, b) => a.createdAt - b.createdAt);
    const seen = new Set<string>();
    for (const j of current) {
      const k = `${j.organizationId}|${j.title.toLowerCase()}`;
      if (seen.has(k)) await ctx.db.patch(employments, j.id, { current: false });
      seen.add(k);
    }
    await ctx.db.patch(people, gone.id, { status: "merged", mergedInto: keep.id, ...(gone.profileId ? {} : {}), updatedAt: Date.now() });
    if (!keep.profileId && gone.profileId) await ctx.db.patch(people, keep.id, { profileId: gone.profileId });
    await history(ctx, keep.id, "person.merged", { mergedId: gone.id, moved });
    await history(ctx, gone.id, "person.merged_into", { keepId: keep.id });
    return { keepId: keep.id, moved };
  },
});

// ------------------------------------------------------------------------------------- evidence

export const evidenceFor = app.query({
  access: "network.read",
  args: { subjectType: s.optional(s.enum(["person", "organization", "employment", "relationship", "tie", "interaction"])), subjectId: s.optional(s.string()), predicate: s.optional(s.string({ maxLength: 60 })), limit: s.optional(s.integer({ minimum: 1, maximum: 200 })) },
  returns: s.array(EvidenceView),
  capability: { name: "evidence.search", description: "The caller's evidence: by subject (type and id) or by predicate (works_at, hiring, knows, skill, interacted, …), newest first, with source, dates, kind (observed, imported, user_provided, inferred, generated), confidence and verification." },
  handler: async (ctx, a) => {
    const ownerId = ownerOf(ctx);
    const list = a.subjectId && a.subjectType ? await ctx.db.find(evidence, { ownerId, subjectType: a.subjectType, subjectId: a.subjectId })
      : a.predicate ? await ctx.db.find(evidence, { ownerId, predicate: a.predicate }, { orderBy: [{ field: "observedAt", direction: "desc" }], limit: a.limit ?? 50 })
      : (await ctx.db.query(evidence, { where: [{ field: "ownerId", eq: ownerId }], orderBy: [{ field: "capturedAt", direction: "desc" }], limit: a.limit ?? 50 })).records;
    return list.slice(0, a.limit ?? 50).map(evidenceView);
  },
});

export const explain = app.query({
  access: "network.read",
  args: { evidenceIds: s.array(s.string(), { minItems: 1, maxItems: 50 }) },
  returns: s.array(s.object({ id: s.string(), found: s.boolean(), evidence: s.nullable(EvidenceView), statement: s.string() })),
  capability: { name: "evidence.explain", description: "Explain each evidence id an answer cited: what it asserts, where it came from, when, of what kind, and whether it still stands. Unknown ids (or another owner's) are reported as not found." },
  handler: async (ctx, { evidenceIds }) => {
    const ownerId = ownerOf(ctx);
    return Promise.all(evidenceIds.map(async (id) => {
      const e = await ctx.db.get(evidence, id);
      if (!e || e.ownerId !== ownerId) return { id, found: false, evidence: null, statement: "No such evidence in your network." };
      const kind = { observed: "Observed", imported: "Imported", user_provided: "You said", inferred: "Inferred (not established)", generated: "Generated by a model (not a fact)" }[e.kind];
      const when = new Date(e.observedAt).toISOString().slice(0, 10);
      const standing = e.verification === "superseded" ? ` Superseded by ${e.supersededBy}.` : e.verification === "disputed" ? " You disputed this." : e.validUntil && e.validUntil < Date.now() ? " Stale: past its validity." : "";
      return { id, found: true, evidence: evidenceView(e), statement: `${kind}: ${e.predicate.replace(/_/g, " ")} — ${e.objectValue} (source: ${e.sourceType.replace(/_/g, " ")}${e.sourceUri ? ` ${e.sourceUri}` : ""}, ${when}, confidence ${e.confidence}).${standing}` };
    }));
  },
});

export const dispute = app.mutation({
  access: "network.write",
  args: { evidenceId: s.string(), note: s.optional(s.string({ maxLength: 300 })) },
  returns: s.object({ evidenceId: s.string(), correctionId: s.string() }),
  owner: { collection: evidence, id: "evidenceId", field: "ownerId" },
  capability: { name: "evidence.dispute", description: "Mark a piece of evidence as wrong. Facts that rest only on it (a position, a skill, a relationship, a tie) stop being used; the evidence and the dispute are both kept." },
  handler: async (ctx, { evidenceId, note }) => {
    const ownerId = ownerOf(ctx);
    const e = (await ctx.db.get(evidence, evidenceId))!;
    if (e.verification === "disputed") fail("FAILED_PRECONDITION", "Already disputed.");
    const c = await addEvidence(ctx, ownerId, { subjectType: e.subjectType, subjectId: e.subjectId, predicate: "disputes", objectValue: `${e.id}${note ? `: ${note}` : ""}`, confidence: 1, ...userSrc(ctx, "dispute") });
    await ctx.db.patch(evidence, e.id, { verification: "disputed", supersededBy: c.id });
    if (e.subjectType === "person") await history(ctx, e.subjectId, "evidence.disputed", { evidenceId: e.id, correctionId: c.id });
    return { evidenceId: e.id, correctionId: c.id };
  },
});

export { HowKnown, Strength };
