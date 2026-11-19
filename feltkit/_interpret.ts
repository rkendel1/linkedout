/**
 * Turning a question into a structured request, by rules. "Who do I know hiring in AI product?"
 * becomes { intent: "search", hiring: true, domains: ["ai"], functions: ["product"] }. Organizations and
 * people are recognized only if they are already in the owner's network, so an interpretation can
 * never introduce someone who isn't there. A model may be asked when the rules find nothing; its
 * answer goes through the same schema and the same deterministic execution. Not a function module.
 */
import { s } from "@feltdb/feltkit";
import { FUNCTIONS, SENIORITY } from "./app.js";
import { domainsIn, nameKey, orgKey, type Function_, type Seniority } from "./_network.js";

export const INTENTS = ["recommend", "search", "paths", "reconnect", "opportunities", "briefing", "changes"] as const;
export type Intent = (typeof INTENTS)[number];

export const Interpretation = s.object({
  intent: s.enum(INTENTS),
  functions: s.array(s.enum(FUNCTIONS)),
  seniority: s.array(s.enum(SENIORITY)),
  domains: s.array(s.string()),
  organizationIds: s.array(s.string()),
  organizations: s.array(s.string()),
  personIds: s.array(s.string()),
  people: s.array(s.string()),
  hiring: s.boolean(),
  text: s.nullable(s.string()),
  /** What the rules recognized, word by word: shown so the owner can see how they were understood. */
  understood: s.array(s.string()),
  /** Nothing specific was recognized: the answer would be the whole network. */
  vague: s.boolean(),
});
export type InterpretationT = {
  intent: Intent; functions: Function_[]; seniority: Seniority[]; domains: string[]; organizationIds: string[]; organizations: string[];
  personIds: string[]; people: string[]; hiring: boolean; text: string | null; understood: string[]; vague: boolean;
};

const FN_WORDS: Array<[Function_, RegExp]> = [
  ["product", /\bproduct\b|\bpms?\b/],
  ["engineering", /\bengineer(?:s|ing)?\b|\bdevelopers?\b|\bcto\b/],
  ["design", /\bdesign(?:ers?)?\b|\bux\b/],
  ["data", /\bdata\b|\banalytics\b/],
  ["research", /\bresearch(?:ers?)?\b|\bscientists?\b/],
  ["sales", /\bsales\b|\bbusiness development\b/],
  ["marketing", /\bmarketing\b|\bgrowth\b/],
  ["operations", /\boperations\b|\bops\b/],
  ["finance", /\bfinance\b|\binvestors?\b|\bvc\b|\bventure\b/],
  ["people", /\brecruit(?:ers?|ing)?\b|\btalent\b|\bhr\b/],
  ["executive", /\bfounders?\b|\bceos?\b|\bexecutives?\b/],
];

/** The owner's organizations and people, as the interpreter matches against them. */
export interface Vocabulary {
  organizations: Array<{ id: string; name: string; nameKey: string }>;
  people: Array<{ id: string; displayName: string; nameKey: string }>;
}

export function interpret(question: string, vocab: Vocabulary): InterpretationT {
  const q = ` ${question.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' &.-]+/g, " ").replace(/\s+/g, " ")} `;
  const understood: string[] = [];
  const functions = FN_WORDS.filter(([, re]) => re.test(q)).map(([f]) => f);
  if (functions.length) understood.push(`function: ${functions.join(", ")}`);
  const seniority: Seniority[] = /\b(leaders?|leadership|senior|executives?|heads?|vps?|vice president|directors?|chief|c-level)\b/.test(q) ? ["director", "vp", "cxo", "founder"] : [];
  if (seniority.length) understood.push("seniority: leadership (director and above)");
  const domains = domainsIn(question).filter((d) => !(d === "data" && functions.includes("data")));
  if (domains.length) understood.push(`domain: ${domains.join(", ")}`);
  const hiring = /\bhiring\b|\bopen (roles?|positions?)\b|\bjobs?\b|\bopenings?\b/.test(q);
  if (hiring) understood.push("hiring");

  const folded = ` ${orgKey(question)} `;
  const orgs = vocab.organizations.filter((o) => o.nameKey.length >= 2 && folded.includes(` ${o.nameKey} `));
  if (orgs.length) understood.push(`organization: ${orgs.map((o) => o.name).join(", ")}`);
  const qn = ` ${nameKey(question)} `;
  let ppl = vocab.people.filter((p) => qn.includes(` ${p.nameKey} `));
  if (!ppl.length) {
    // A first name alone ("I'm meeting Sarah tomorrow") names everyone with that first name; the answer says so.
    const firsts = vocab.people.filter((p) => p.nameKey.split(" ")[0]!.length >= 3 && qn.includes(` ${p.nameKey.split(" ")[0]} `) && /\b(meet|meeting|prepare|prep|brief|about|with|call|talk|coffee|lunch)\b/.test(q));
    ppl = firsts;
  }
  if (ppl.length) understood.push(`person: ${ppl.map((p) => p.displayName).join(", ")}`);

  let intent: Intent = "search";
  if (/\bintro(duc(e|tion|ed)?)?\b|\bget (me )?to\b|\bconnect me (to|with)\b|\bin at\b/.test(q)) intent = "paths";
  else if (/\breconnect\b|\blost touch\b|\bhaven't (talked|spoken)\b|\bcatch up\b|\bout of touch\b|\bfallen? out\b/.test(q)) intent = "reconnect";
  else if (ppl.length && /\b(prepare|prep|brief|meeting|meet|before|talking points)\b/.test(q)) intent = "briefing";
  else if (/\bwhat('s| has| is)? (changed|new)\b|\bchanges\b|\bupdates?\b|\bwhat happened\b/.test(q)) intent = "changes";
  else if (/\b(next|new) (role|job|opportunity|position|move|chapter)\b|\bcould help\b|\bhelp me find\b|\bcareer\b|\brelevant\b|\bshould i talk\b/.test(q)) intent = "recommend";
  else if (hiring && !/\bwho\b|\bpeople\b|\banyone\b|\bknow\b/.test(q)) intent = "opportunities";
  understood.unshift(`intent: ${intent}`);

  const vague = !functions.length && !seniority.length && !domains.length && !orgs.length && !ppl.length && !hiring && intent === "search";
  return {
    intent, functions, seniority, domains, hiring,
    organizationIds: orgs.map((o) => o.id), organizations: orgs.map((o) => o.name),
    personIds: ppl.map((p) => p.id), people: ppl.map((p) => p.displayName),
    text: vague ? question.trim().slice(0, 200) : null, understood, vague,
  };
}
