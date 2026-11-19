/**
 * The conversational interface: a question in, an answer built from the owner's records out.
 *
 * 1. Rules interpret the question (`intel.interpret`): intent, functions, domains, organizations and
 *    people already in the owner's network.
 * 2. Only when the rules recognize nothing specific, and a model is configured, the model is asked to
 *    choose ONE of Frame's read capabilities and its arguments. Its choice runs through FeltKit's
 *    proposal path as the owner (observations run; nothing else is offered), and the generation is
 *    recorded as durable evidence on the turn's task.
 * 3. The answer is composed here, deterministically, from what the capability returned. A model never
 *    writes the answer's facts, so it cannot add a person, a relationship or a hiring claim.
 *
 * With no model configured, or with any provider, the same question gets the same kind of answer.
 */
import { s, type ActionCtx } from "@feltdb/feltkit";
import { app } from "./app.js";
import { api } from "./_generated/api.js";
import { goalPhrase, type InterpretationT } from "./_interpret.js";

/** The read capabilities the model may choose among. Each maps to an intent the answer is composed for. */
const READS = {
  "intel.recommend": "recommend",
  "network.search": "search",
  "network.paths": "paths",
  "intel.reconnect": "reconnect",
  "opportunity.search": "opportunities",
  "briefing.person": "briefing",
  "briefing.changes": "changes",
} as const;
type ReadName = keyof typeof READS;

const SYSTEM = `You route a person's question about their own professional network to exactly one tool.
Call one tool with arguments taken from the question. Do not answer the question yourself, and do not
name people, companies or facts that are not in the question.
- Who knows about / works in / has experience with a subject: network.search, using its structured
  fields (domains, functions, seniority, skills, organization) rather than free text where they fit.
- Who could help with the person's own next role or career goal: intel.recommend.
- Reaching someone at an organization: network.paths. Lost touch: intel.reconnect. Hiring and open
  roles: opportunity.search. Preparing to meet a named person: briefing.person. What changed: briefing.changes.
If no tool fits, call network.search with the question's key words as "text".`;

export interface AskResult {
  question: string;
  intent: string;
  via: "rules" | "model";
  interpretation: InterpretationT;
  /** When the model routed the question: which model, its task (generation evidence), and the call it chose. */
  model: { provider: string; model: string; taskId: string; capability: string; input: Record<string, unknown> } | null;
  answer: string;
  /** Every evidence id the answer rests on (evidence.explain explains each). */
  evidenceIds: string[];
  /** The capability's own result, for screens and agents that want the structure. */
  result: unknown;
  limitations: string[];
}

export const ask = app.action({
  access: "network.read",
  args: { question: s.string({ minLength: 1, maxLength: 500 }) },
  handler: async (ctx, { question }): Promise<AskResult> => {
    const interpretation = await ctx.runQuery(api.intel.interpretQuestion, { question });
    let intent: string = interpretation.intent;
    let via: AskResult["via"] = "rules";
    let model: AskResult["model"] = null;
    let result: unknown;
    const limitations: string[] = [];

    if (interpretation.vague) {
      const status = await ctx.model.status();
      if (status.ready) {
        const chosen = await viaModel(ctx, question).catch((e: Error) => {
          limitations.push(`The model could not be used (${e.message.slice(0, 120)}); answered by rules.`);
          return null;
        });
        if (chosen) ({ intent, result, model } = chosen), (via = "model");
      }
    }
    if (result === undefined) result = await byRules(ctx, interpretation);
    const composed = compose(intent, result, interpretation);
    return { question, intent, via, interpretation, model, answer: composed.answer, evidenceIds: [...new Set(composed.evidenceIds)], result, limitations: [...limitations, ...composed.limitations] };
  },
});

async function viaModel(ctx: ActionCtx, question: string) {
  const { taskId } = await ctx.agent.openTask({ key: `ask:${ctx.requestId}`, objective: question });
  const tools = (await ctx.agent.tools()).filter((t) => t.name in READS && t.effect === "observation");
  const messages: Parameters<ActionCtx["model"]["generate"]>[0]["messages"] = [{ role: "system", content: SYSTEM }, { role: "user", content: question }];
  // At most two attempts: if the capability's contract refuses the model's arguments, the model is told
  // exactly why, once. Anything still invalid falls back to the rules.
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const g = await ctx.model.generate({ taskId, messages, tools, maxTokens: 300, stream: false } as Parameters<ActionCtx["model"]["generate"]>[0]);
    const call = g.toolCalls.find((c) => c.name in READS);
    if (!call) return null;
    const done = await ctx.agent.propose(taskId, {
      capability: call.name, input: call.input, reason: question, idempotencyKey: `${attempt}:${call.id}`,
      model: { provider: g.receipt.provider, model: g.receipt.model, generation: { memoryId: g.memoryId, toolCallId: call.id } },
    });
    if (done.state === "succeeded") return { intent: READS[call.name as ReadName], result: done.output, model: { provider: g.receipt.provider, model: g.receipt.model, taskId, capability: call.name, input: call.input } };
    lastError = done.error?.message ?? `the ${call.name} call ${done.state}`;
    messages.push({ role: "assistant", content: "", toolCalls: [call] }, { role: "tool", toolCallId: call.id, content: `Refused: ${lastError}. Call the tool again with valid arguments.` });
  }
  throw new Error(lastError);
}

function byRules(ctx: ActionCtx, i: InterpretationT): Promise<unknown> {
  switch (i.intent) {
    case "recommend":
      // The question's own role and domain when it names them; otherwise the owner's saved goal.
      return ctx.runQuery(api.intel.recommend, i.functions.length || i.domains.length || i.organizationIds.length ? { goal: `${goalPhrase(i)}${i.organizations.length ? ` at ${i.organizations.join(" or ")}` : ""}` } : {});
    case "paths":
      return i.organizations[0] ? ctx.runQuery(api.intel.paths, { organization: i.organizations[0] }) : i.personIds[0] ? ctx.runQuery(api.intel.paths, { personId: i.personIds[0] }) : Promise.resolve({ target: "", paths: [], limitations: ["Name an organization or a person in your network to find a path to."] });
    case "reconnect":
      return ctx.runQuery(api.intel.reconnect, {});
    case "opportunities":
      return ctx.runQuery(api.intel.opportunities, {});
    case "briefing":
      return i.personIds.length === 1 ? ctx.runQuery(api.intel.briefing, { personId: i.personIds[0]! }) : Promise.resolve({ ambiguous: i.people });
    case "changes":
      return ctx.runQuery(api.intel.changes, {});
    default:
      return ctx.runQuery(api.network.search, {
        ...(i.text ? { text: i.text } : {}), ...(i.functions.length ? { functions: i.functions } : {}), ...(i.seniority.length ? { seniority: i.seniority } : {}),
        ...(i.domains.length ? { domains: i.domains } : {}), ...(i.organizations[0] ? { organization: i.organizations[0] } : {}),
      }).then(async (r) => (i.hiring ? { ...r, hiring: await ctx.runQuery(api.intel.opportunities, {}) } : r));
  }
}

// ---------------------------------------------------------------------------------------- compose

type Reasonish = { text: string; evidenceIds: string[] };
const list = (n: number, word: string) => `${n} ${n === 1 ? word : word === "person" ? "people" : `${word}s`}`;

/** Plain-language answers from structured results. Every claim here is a field of the result. */
function compose(intent: string, r: any, i: InterpretationT): { answer: string; evidenceIds: string[]; limitations: string[] } {
  const ev: string[] = [];
  const cite = (rs: Reasonish[]) => { for (const x of rs) ev.push(...x.evidenceIds); return rs.map((x) => x.text).join("; "); };
  const lim: string[] = [...(r?.limitations ?? [])];
  const out: string[] = [];
  switch (intent) {
    case "recommend": {
      if (!r.people?.length) { out.push(r.goal ? `No one in your network stands out yet for “${r.goal.text}”.` : "Set a goal first, or ask about a role and domain (e.g. “AI product leadership”)."); break; }
      out.push(`For “${r.goal.text}”, ${list(r.people.length, "person")} in your network ${r.people.length === 1 ? "stands" : "stand"} out (of ${r.considered} you know):`);
      r.people.forEach((x: any, n: number) => {
        const how = x.person.howKnown.filter((h: any) => h.type !== "suggested").map((h: any) => `${h.type} via ${h.source.replace(/_/g, " ")}${h.establishedAt ? ` since ${h.establishedAt.slice(0, 4)}` : ""}`).join(", ");
        out.push(`${n + 1}. ${x.person.displayName}${x.person.current[0] ? ` — ${x.person.current[0].title} at ${x.person.current[0].organization}` : ""}. Why: ${cite(x.reasons)}. How you know them: ${how || "no established relationship"} (strength: ${x.person.strength.level}).`);
      });
      break;
    }
    case "search": {
      const ppl = r.people ?? [];
      if (r.unknownOrganization) out.push(`No organization named “${r.unknownOrganization}” is in your network.`);
      else if (!ppl.length) out.push(`No one in your network matches${i.understood.length > 1 ? ` (${i.understood.slice(1).join("; ")})` : ""}.`);
      else {
        out.push(`${list(r.total, "person")} in your network match${r.total === 1 ? "es" : ""}${i.understood.length > 1 ? ` (${i.understood.slice(1).join("; ")})` : ""}:`);
        for (const x of ppl.slice(0, 10)) out.push(`• ${x.person.displayName}${x.person.current[0] ? ` — ${x.person.current[0].title} at ${x.person.current[0].organization}` : ""} (${x.person.relationship}). ${cite(x.reasons)}`);
      }
      if (r.hiring) {
        const orgs = new Set(ppl.flatMap((x: any) => x.person.current.map((c: any) => c.organizationId)));
        const hiring = (r.hiring as any[]).filter((o) => orgs.has(o.organizationId));
        if (hiring.length) for (const o of hiring) { out.push(`Hiring: ${o.organization} — ${o.roles.join("; ")} (${o.evidence.length} source${o.evidence.length > 1 ? "s" : ""}).`); ev.push(...o.evidence.map((e: any) => e.id)); }
        else lim.push("None of their organizations has active hiring evidence in your network.");
      }
      break;
    }
    case "paths": {
      if (!r.paths?.length) { out.push(`No known way to reach ${r.target || "them"} yet.`); break; }
      out.push(`Ways to reach ${r.target}:`);
      for (const p of r.paths.slice(0, 8)) { out.push(`• ${p.explanation}`); for (const h of p.hops) ev.push(...h.evidenceIds); }
      lim.push("A path is not a promise of an introduction: ask first.");
      break;
    }
    case "reconnect": {
      if (!r.people?.length) { out.push("No one you know has gone quiet by that measure."); break; }
      out.push("People worth reconnecting with:");
      for (const x of r.people.slice(0, 8)) out.push(`• ${x.person.displayName}${x.person.current[0] ? ` — ${x.person.current[0].title} at ${x.person.current[0].organization}` : ""}: ${cite(x.why)}.`);
      break;
    }
    case "opportunities": {
      const active = (r as any[]).filter((o) => o.active);
      if (!active.length) { out.push("No active hiring evidence in your network."); break; }
      out.push(`${list(active.length, "organization")} in your network ${active.length === 1 ? "is" : "are"} hiring:`);
      for (const o of active) { out.push(`• ${o.organization}: ${o.roles.join("; ")}. ${o.contacts.length ? `You know ${o.contacts.map((c: any) => c.displayName).join(", ")} there.` : "You know no one there yet."}${o.relevance.length ? ` ${o.relevance.join("; ")}.` : ""}`); ev.push(...o.evidence.map((e: any) => e.id)); }
      break;
    }
    case "briefing": {
      if (r.ambiguous) { out.push(r.ambiguous.length ? `Which one: ${r.ambiguous.join(", ")}?` : "Who are you meeting? Name someone in your network."); break; }
      out.push(`Briefing: ${r.person.displayName}${r.person.current[0] ? `, ${r.person.current[0].title} at ${r.person.current[0].organization}` : ""}.`);
      if (r.verified.length) out.push(`Verified (your word): ${cite(r.verified)}.`);
      if (r.imported.length) out.push(`Imported: ${cite(r.imported)}.`);
      if (r.observed.length) out.push(`Observed: ${cite(r.observed)}.`);
      if (r.hiringAtTheirOrganization.length) out.push(`Hiring: ${cite(r.hiringAtTheirOrganization)}.`);
      if (r.inferred.length) out.push(`Inferred (not established): ${cite(r.inferred)}.`);
      if (r.suggestions.length) out.push(`Suggestions: ${r.suggestions.join(" ")}`);
      break;
    }
    case "changes": {
      if (!r.moves.length && !r.hiring.length && !r.followupsDue.length) { out.push("Nothing new in your network in the last 30 days."); break; }
      for (const m of r.moves) { out.push(`• ${m.displayName} moved: ${m.from} → ${m.to}.`); ev.push(...m.evidenceIds); }
      for (const h of r.hiring) { out.push(`• ${h.organization} is hiring: ${h.text}.`); ev.push(h.evidenceId); }
      for (const f of r.followupsDue) out.push(`• Follow up with ${f.displayName}${f.overdue ? " (overdue)" : ""}: ${f.reason}.`);
      break;
    }
  }
  return { answer: out.join("\n"), evidenceIds: ev, limitations: lim };
}
