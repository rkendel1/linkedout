/**
 * LinkedOut's deterministic rules: who the owner is, how names, organizations and identifiers are
 * normalized for entity resolution, how a title is classified, how a domain is recognized, how a CSV
 * is read, and how evidence is written (once per fact, by content hash). No model is involved in any
 * of this: these are the rules the network's correctness depends on. Not a function module.
 */
import { fail, type DatabaseReader, type Doc, type MutationCtx, type QueryCtx } from "@feltdb/feltkit";
import { EVIDENCE_KINDS, FUNCTIONS, SENIORITY, SOURCE_TYPES, evidence, ledger, organizations, people } from "./app.js";

export type PersonDoc = Doc<typeof people.shape>;
export type EvidenceDoc = Doc<typeof evidence.shape>;
export type Seniority = (typeof SENIORITY)[number];
export type Function_ = (typeof FUNCTIONS)[number];
export type SourceType = (typeof SOURCE_TYPES)[number];
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const DAY = 86_400_000;

// --------------------------------------------------------------------------------------------- owner

/** The network being read or written is always the verified caller's own. Never an argument. */
export function ownerOf(ctx: { auth: QueryCtx["auth"] }): string {
  return ctx.auth.requirePrincipal().id;
}

/**
 * The owner's person record, following a merge to the survivor. Another owner's record and an
 * unknown id are the same answer (NOT_FOUND), so ids leak nothing across networks.
 */
export async function ownPerson(db: DatabaseReader, ownerId: string, id: string): Promise<PersonDoc> {
  let p = await db.get(people, id);
  for (let hops = 0; p && p.status === "merged" && p.mergedInto && hops < 5; hops++) p = await db.get(people, p.mergedInto);
  if (!p || p.ownerId !== ownerId || p.status !== "active") fail("NOT_FOUND", "That person is not in your network.");
  return p!;
}

// ------------------------------------------------------------------------------------- normalization

const fold = (v: string) => v.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** "Dr. José Núñez, PhD 🚀" → "jose nunez". Credentials after a comma and honorifics are not part of a name. */
export function nameKey(name: string): string {
  const base = fold(name.split(",")[0] ?? "").replace(/\b(dr|mr|mrs|ms|prof)\.?\s+/g, " ");
  return base.replace(/[^a-z0-9' -]/g, " ").replace(/['-]/g, "").replace(/\s+/g, " ").trim();
}

const ORG_SUFFIX = /\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|gmbh|plc|sa|ag|bv|pty)\b\.?/g;
/** "OpenAI, Inc." and "openai" are one organization. */
export function orgKey(name: string): string {
  return fold(name).replace(/&/g, " and ").replace(/[^a-z0-9 ]/g, " ").replace(ORG_SUFFIX, " ").replace(/^the\s+/, "").replace(/\s+/g, " ").trim();
}

export function emailKey(email: string): string | null {
  const e = email.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

/** "https://www.linkedin.com/in/Jane-Doe/?x=1" → "linkedin.com/in/jane-doe". */
export function linkedinKey(url: string): string | null {
  const m = url.trim().toLowerCase().match(/linkedin\.com\/(in|pub)\/([^/?#\s]+)/);
  return m ? `linkedin.com/in/${decodeURIComponent(m[2]!)}` : null;
}

/** "12 Mar 2021", "2021-03-12", "03/12/2021", "2021-03", "2021" → an ISO date, or null. */
export function isoDate(v: string | undefined): string | null {
  const t = (v ?? "").trim();
  if (!t) return null;
  if (/^\d{4}(-\d{2}(-\d{2})?)?$/.test(t)) return t;
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  let m = t.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})$/);
  if (m) {
    const mo = months.indexOf(m[2]!.toLowerCase());
    if (mo >= 0) return `${m[3]}-${String(mo + 1).padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  }
  m = t.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mo = months.indexOf(m[1]!.toLowerCase());
    if (mo >= 0) return `${m[3]}-${String(mo + 1).padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  }
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  return null;
}

export const dateMs = (iso: string | null | undefined) => (iso ? Date.parse(iso.length === 4 ? `${iso}-01-01` : iso.length === 7 ? `${iso}-01` : iso) : NaN);

// ------------------------------------------------------------------------------------ classification

/** Words of a text, folded, for whole-word matching ("ai" never matches "maintain"). */
const words = (text: string) => ` ${fold(text).replace(/[^a-z0-9+#]+/g, " ").trim()} `;
const has = (w: string, phrase: string) => w.includes(` ${phrase} `);

export function seniorityOf(title: string): Seniority {
  const w = words(title);
  if (!w.trim()) return "unknown";
  if (["chief", "ceo", "cto", "cpo", "coo", "cfo", "cmo", "ciso", "cdo", "cro"].some((k) => has(w, k))) return "cxo";
  if (["founder", "cofounder", "co founder"].some((k) => has(w, k))) return "founder";
  if (["vp", "vice president", "svp", "evp", "avp"].some((k) => has(w, k))) return "vp";
  if (["director", "head of", "head", "general manager", "managing director", "partner"].some((k) => has(w, k))) return "director";
  // A product, program or project manager is an individual contributor; a manager of a team is not.
  if (/ (product|program|project|account|community|campaign) manager /.test(w) && !has(w, "group product manager")) return "ic";
  if (["manager", "lead", "supervisor"].some((k) => has(w, k))) return "manager";
  return "ic";
}

const FUNCTION_WORDS: Array<[Function_, string[]]> = [
  ["executive", ["ceo", "founder", "cofounder", "co founder", "president", "general manager", "managing director", "chief executive"]],
  ["design", ["design", "designer", "ux", "ui", "user experience", "creative director"]],
  ["product", ["product", "cpo", "pm"]],
  ["research", ["research", "researcher", "scientist"]],
  ["data", ["data", "analytics", "analyst", "bi"]],
  ["engineering", ["engineer", "engineering", "developer", "cto", "swe", "sre", "devops", "architect", "software", "infrastructure", "ml engineer"]],
  ["people", ["recruiter", "recruiting", "talent", "hr", "human resources", "people operations", "people"]],
  ["sales", ["sales", "account executive", "business development", "bdr", "sdr", "partnerships", "customer success"]],
  ["marketing", ["marketing", "growth", "brand", "content", "cmo", "communications", "community"]],
  ["finance", ["finance", "cfo", "accounting", "investor", "investment", "venture", "capital"]],
  ["operations", ["operations", "coo", "ops", "program manager", "project manager", "chief of staff", "strategy"]],
];

export function functionOf(title: string): Function_ {
  const w = words(title);
  for (const [f, ks] of FUNCTION_WORDS) if (ks.some((k) => has(w, k))) return f;
  return "other";
}

/**
 * Domains Frame recognizes, by whole words or phrases. A person or organization is "in" a domain
 * only when one of these occurs in an evidenced field (a title, a headline, an organization's name or
 * industry, a skill). The table is code: reviewable, testable, and the same tomorrow.
 */
export const DOMAINS: Record<string, string[]> = {
  ai: ["ai", "a i", "artificial intelligence", "machine learning", "ml", "llm", "llms", "genai", "generative ai", "deep learning", "nlp", "computer vision", "mlops", "ai ml", "foundation models", "openai", "anthropic", "deepmind"],
  infrastructure: ["infrastructure", "infra", "cloud", "platform engineering", "kubernetes", "devops", "distributed systems"],
  data: ["data", "analytics", "data science", "data engineering", "business intelligence"],
  fintech: ["fintech", "payments", "banking", "lending", "financial services", "insurtech"],
  health: ["health", "healthcare", "medical", "biotech", "clinical", "digital health", "pharma"],
  climate: ["climate", "energy", "sustainability", "solar", "cleantech", "carbon"],
  security: ["security", "cybersecurity", "cyber", "identity", "infosec"],
  devtools: ["developer tools", "devtools", "developer experience", "developer platform", "sdk", "api"],
  crypto: ["crypto", "blockchain", "web3", "defi"],
  education: ["education", "edtech", "learning"],
  commerce: ["ecommerce", "e commerce", "retail", "marketplace", "commerce"],
  media: ["media", "publishing", "journalism", "entertainment", "gaming"],
  saas: ["saas", "b2b", "enterprise software"],
};

export const DOMAIN_NAMES = Object.keys(DOMAINS) as [string, ...string[]];

export function domainsIn(text: string): string[] {
  const w = words(text);
  return Object.entries(DOMAINS).filter(([, ks]) => ks.some((k) => has(w, k))).map(([d]) => d);
}

/** Canonical skill names: lowercase, trimmed, common spellings joined. */
const SKILL_ALIASES: Record<string, string> = { "ml": "machine learning", "ai": "artificial intelligence", "pm": "product management", "js": "javascript", "ts": "typescript", "k8s": "kubernetes", "genai": "generative ai", "llms": "llm" };
export function skillKey(skill: string): string | null {
  const k = fold(skill).replace(/[^a-z0-9+#. ]/g, " ").replace(/\s+/g, " ").trim();
  if (!k || k.length > 60) return null;
  return SKILL_ALIASES[k] ?? k;
}

/** Hiring language in a public post: "#hiring", "we're hiring", "join our team", "open roles". */
export function isHiringText(text: string): boolean {
  return /#hiring\b/i.test(text) || /\b(we(?:'|’)?re hiring|we are hiring|now hiring|is hiring|hiring (?:a|an|for|our)|join (?:our|my) team|open (?:roles?|positions?)|come work with)\b/i.test(text);
}

// ------------------------------------------------------------------------------------------------- csv

/** RFC 4180: quoted fields, doubled quotes, newlines inside quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

const HEADERS = {
  first: ["first name", "firstname", "given name"],
  last: ["last name", "lastname", "surname", "family name"],
  name: ["name", "full name", "display name"],
  email: ["email address", "email", "e-mail", "email addresses"],
  linkedin: ["url", "linkedin", "linkedin url", "profile url"],
  company: ["company", "organization", "organisation", "employer"],
  title: ["position", "title", "job title", "role"],
  connectedOn: ["connected on", "connected", "since"],
  location: ["location", "city"],
  skills: ["skills", "expertise"],
  industry: ["industry"],
  headline: ["headline", "summary"],
  notes: ["notes", "context", "how we know each other"],
} satisfies Record<string, string[]>;
export type ConnectionRow = { row: number } & Partial<Record<keyof typeof HEADERS, string>>;

/**
 * Rows of a connection export. LinkedIn's "Connections.csv" opens with a few lines of notes before
 * its header; the header is the first row that names a person's name columns.
 */
export function connectionRows(text: string): { source: "linkedin_export" | "csv_import"; rows: ConnectionRow[] } {
  const all = parseCsv(text.replace(/^﻿/, ""));
  const at = all.findIndex((r) => {
    const h = r.map((c) => c.trim().toLowerCase());
    return (h.includes("first name") && h.includes("last name")) || h.some((c) => HEADERS.name.includes(c));
  });
  if (at < 0) fail("INVALID_ARGUMENT", "No header row found: the file needs First Name and Last Name columns, or a Name column.");
  const header = all[at]!.map((c) => c.trim().toLowerCase());
  const col: Partial<Record<keyof typeof HEADERS, number>> = {};
  for (const [key, names] of Object.entries(HEADERS)) {
    const i = header.findIndex((h) => (names as string[]).includes(h));
    if (i >= 0) col[key as keyof typeof HEADERS] = i;
  }
  const linkedin = header.includes("first name") && header.includes("connected on");
  const rows = all.slice(at + 1).map((r, i) => {
    const out: ConnectionRow = { row: at + i + 2 };
    for (const [key, idx] of Object.entries(col)) {
      const v = r[idx!]?.trim();
      if (v) out[key as keyof typeof HEADERS] = v;
    }
    return out;
  });
  return { source: linkedin ? "linkedin_export" : "csv_import", rows };
}

// -------------------------------------------------------------------------------------------- hashing

export async function sha256(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ------------------------------------------------------------------------------------------- evidence

export interface EvidenceInput {
  subjectType: EvidenceDoc["subjectType"];
  subjectId: string;
  predicate: string;
  objectValue: string;
  kind: EvidenceKind;
  sourceType: SourceType;
  sourceReference: string;
  sourceUri?: string;
  observedAt: number;
  publishedAt?: number;
  validFrom?: string;
  validUntil?: number;
  confidence: number;
}

/**
 * Write a piece of evidence once. The same assertion from the same kind of source on the same day is
 * the same evidence (its content hash is unique per owner), so re-running an import, a sync or a
 * correction never multiplies facts. Returns the evidence id and whether it was new.
 */
export async function addEvidence(ctx: Pick<MutationCtx, "db">, ownerId: string, e: EvidenceInput): Promise<{ id: string; created: boolean }> {
  const day = new Date(e.observedAt).toISOString().slice(0, 10);
  const contentHash = await sha256([e.subjectType, e.subjectId, e.predicate, e.objectValue.trim().toLowerCase(), e.kind, e.sourceType, e.sourceType === "frame_post" ? e.sourceReference : day].join("␟"));
  const [existing] = await ctx.db.find(evidence, { ownerId, contentHash });
  if (existing) return { id: existing.id, created: false };
  const id = await ctx.db.insert(evidence, {
    ownerId, ...e, objectValue: e.objectValue.slice(0, 2000), capturedAt: Date.now(),
    verification: e.kind === "user_provided" ? "user_confirmed" : "unverified", contentHash,
  });
  return { id, created: true };
}

/** Get an organization of the owner's by name, creating it (with evidence of the name) if it is new. */
export async function organizationNamed(ctx: Pick<MutationCtx, "db">, ownerId: string, name: string, source: { sourceType: SourceType; sourceReference: string; kind: EvidenceKind; observedAt: number }, extra: { industry?: string } = {}) {
  const key = orgKey(name);
  if (!key) fail("INVALID_ARGUMENT", "An organization needs a name.");
  const [found] = await ctx.db.find(organizations, { ownerId, nameKey: key });
  if (found) {
    if (extra.industry && !found.industry) await ctx.db.patch(organizations, found.id, { industry: extra.industry });
    return found.id;
  }
  const id = await ctx.db.insert(organizations, { ownerId, name: name.trim().slice(0, 160), nameKey: key, createdAt: Date.now(), ...(extra.industry ? { industry: extra.industry } : {}) });
  await addEvidence(ctx, ownerId, { subjectType: "organization", subjectId: id, predicate: "name", objectValue: name.trim(), confidence: 0.9, ...source });
  return id;
}

/** One line in a person's history (the owner's ledger), in the change's own transaction. */
export async function history(ctx: MutationCtx, personId: string, type: string, data: Record<string, string | number | boolean | undefined> = {}) {
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) as Record<string, string | number | boolean>;
  await ledger.record(ctx, { subject: "person", id: personId, type, data: clean });
}
