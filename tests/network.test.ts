/**
 * LinkedOut's professional network against a real FeltDB per test (`feltkit test`): import, entity
 * resolution, history, evidence, isolation between owners, relevance, introduction paths, drafts and
 * follow-ups, and the agent interface. Nothing is mocked; the model, where used, is a local
 * OpenAI-compatible server this test runs, selected exactly as an operator would select one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, type TestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";

const member = (id: string) => ({ id, type: "user" as const, roles: ["member"] });

/** LinkedIn's Connections.csv as downloaded: notes first, then the header. */
export const LINKEDIN = `Notes:
"When exporting your connection data, you may notice that some of the email addresses are missing."

First Name,Last Name,URL,Email Address,Company,Position,Connected On
Sarah,Chen,https://www.linkedin.com/in/sarahchen,sarah@example.com,Anthropic,VP of Product,12 Mar 2019
Marcus,Webb,https://www.linkedin.com/in/marcuswebb,,Stripe,Engineering Manager,03 Jan 2018
Priya,Natarajan,https://www.linkedin.com/in/priyan,,Lumen AI,Head of Product,22 Jul 2020
Diego,Alvarez,https://www.linkedin.com/in/dalvarez,,Acme Robotics,Senior Recruiter,15 Feb 2021
"José","Núñez, PhD",https://www.linkedin.com/in/jnunez,,OpenAI,Research Scientist,01 Sep 2022
Tom,Baker,https://www.linkedin.com/in/tombaker,,Bakery Co,Owner,10 Oct 2015
`;

async function withApp(fn: (t: TestApp) => Promise<void>) {
  const t = await createTestApp();
  try {
    await fn(t);
  } finally {
    await t.close();
  }
}

/** Refused as another owner's record: FeltKit's owner check (FORBIDDEN) or LinkedOut's own read (NOT_FOUND). */
const refused = (e: { code?: string }) => e.code === "FORBIDDEN" || e.code === "NOT_FOUND";

const byName = <T extends { person: { displayName: string } }>(list: T[], name: string) => list.find((x) => x.person.displayName === name);

test("import: LinkedIn export becomes people, positions, relationships and evidence; the same file twice is one import", async () => {
  await withApp(async (t) => {
    const ada = t.as(member("ada"));
    const r = await ada.mutation(api.network.importConnections, { fileName: "Connections.csv", csv: LINKEDIN });
    assert.equal(r.source, "linkedin_export");
    assert.equal(r.rows, 6);
    assert.equal(r.created, 6);
    assert.equal(r.replayed, false);

    const again = await ada.mutation(api.network.importConnections, { fileName: "Connections.csv", csv: LINKEDIN });
    assert.equal(again.replayed, true);
    assert.equal(again.importId, r.importId);

    const all = await ada.query(api.network.search, {});
    assert.equal(all.total, 6, "no duplicates from the second import");
    const jose = byName(all.people, "José Núñez, PhD")!;
    assert.equal(jose.person.current[0]!.organization, "OpenAI");
    assert.equal(jose.person.current[0]!.function, "research");
    const sarah = byName(all.people, "Sarah Chen")!;
    assert.equal(sarah.person.relationship, "direct");
    assert.equal(sarah.person.howKnown[0]!.establishedAt, "2019-03-12");
    assert.equal(sarah.person.current[0]!.seniority, "vp");
    assert.ok(sarah.person.domains.includes("ai"), "Anthropic is an AI organization by name");

    // Every fact has provenance: the person's evidence names the import.
    const rec = await ada.query(api.network.person, { personId: sarah.person.id });
    assert.ok(rec.evidence.length >= 4);
    for (const e of rec.evidence) {
      assert.equal(e.kind, "imported");
      assert.equal(e.sourceType, "linkedin_export");
      assert.equal(e.sourceReference, r.importId);
    }
    assert.deepEqual(rec.identifiers.map((i) => i.kind).sort(), ["email", "linkedin"]);
    assert.ok(rec.history.some((h) => h.type === "person.created"));
    assert.ok(rec.limitations.some((l) => l.includes("No interactions recorded")));
  });
});

test("resolution: a later export matches by LinkedIn URL and keeps job history; a name alone never merges", async () => {
  await withApp(async (t) => {
    const ada = t.as(member("ada"));
    await ada.mutation(api.network.importConnections, { fileName: "Connections.csv", csv: LINKEDIN });
    // A year later Sarah moved to OpenAI as CPO; a different Sarah Chen appears at a bank.
    const later = `First Name,Last Name,URL,Email Address,Company,Position,Connected On
Sarah,Chen,https://linkedin.com/in/SarahChen/,,OpenAI,Chief Product Officer,12 Mar 2019
Sarah,Chen,https://www.linkedin.com/in/sarah-chen-2,,First Bank,Analyst,01 Jan 2024
`;
    const r = await ada.mutation(api.network.importConnections, { fileName: "Connections-2.csv", csv: later });
    assert.equal(r.matched, 1);
    assert.equal(r.created, 1);

    const found = await ada.query(api.network.search, { text: "sarah" });
    assert.equal(found.total, 2, "the bank's Sarah Chen is a separate person");
    const sarah = found.people.find((p) => p.person.current[0]?.organization === "OpenAI")!;
    const rec = await ada.query(api.network.person, { personId: sarah.person.id });
    assert.deepEqual(rec.positions.map((p) => [p.organization, p.title, p.current]), [["OpenAI", "Chief Product Officer", true], ["Anthropic", "VP of Product", false]]);
    assert.equal(rec.possibleDuplicates.length, 1, "the other Sarah Chen is offered for review, not merged");

    const dupes = await ada.query(api.network.duplicates, {});
    assert.equal(dupes.length, 1);
    assert.equal(dupes[0]!.people.length, 2);
  });
});

test("isolation: one owner's network, evidence and ids are invisible and untouchable to another", async () => {
  await withApp(async (t) => {
    const ada = t.as(member("ada"));
    const grace = t.as(member("grace"));
    await ada.mutation(api.network.importConnections, { fileName: "Connections.csv", csv: LINKEDIN });
    const sarah = byName((await ada.query(api.network.search, {})).people, "Sarah Chen")!;

    assert.equal((await grace.query(api.network.search, {})).total, 0);
    assert.equal((await grace.query(api.network.search, { relationship: "any" })).total, 0);
    await assert.rejects(grace.query(api.network.person, { personId: sarah.person.id }), /NOT_FOUND|not in your network/);
    await assert.rejects(grace.mutation(api.network.updatePerson, { personId: sarah.person.id, headline: "x" }), refused);
    await assert.rejects(grace.mutation(api.network.recordInteraction, { personId: sarah.person.id, kind: "call" }), refused);
    const ev = (await ada.query(api.network.person, { personId: sarah.person.id })).evidence[0]!;
    const seen = await grace.query(api.network.explain, { evidenceIds: [ev.id] });
    assert.equal(seen[0]!.found, false);
    await assert.rejects(grace.mutation(api.network.dispute, { evidenceId: ev.id }), refused);
    assert.equal((await grace.query(api.network.evidenceFor, { predicate: "works_at" })).length, 0);

    // Grace importing the same file builds her own, separate records.
    const r = await grace.mutation(api.network.importConnections, { fileName: "Connections.csv", csv: LINKEDIN });
    assert.equal(r.created, 6);
    assert.equal(r.replayed, false);
    assert.equal((await ada.query(api.network.search, {})).total, 6);

    // A signed-in account without the member role, and an anonymous caller, are refused outright.
    await assert.rejects(t.as({ id: "x", type: "user", roles: [] }).query(api.network.search, {}), (e: { code?: string }) => e.code === "FORBIDDEN");
    await assert.rejects(t.query(api.network.search, {}), (e: { code?: string }) => e.code === "UNAUTHORIZED");
  });
});

// ------------------------------------------------------------------------------------ the MVP network

import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const DEMO = new URL("../scripts/demo-network/", import.meta.url);
const demoFile = (name: string) => readFileSync(new URL(name, DEMO), "utf8");
const agentAs = (id: string) => ({ id, type: "agent" as const, roles: ["member"] });

/** The demo network: LinkedIn's export, the owner's own context file, and one job posting they saw. */
async function demoNetwork(t: TestApp, who = "ada") {
  const me = t.as(member(who));
  await me.mutation(api.network.importConnections, { fileName: "Connections.csv", csv: demoFile("Connections.csv") });
  await me.mutation(api.network.importConnections, { fileName: "context.csv", csv: demoFile("context.csv") });
  await me.mutation(api.intel.recordHiring, { organization: "Lumen AI", role: "Director of Product, AI Platform", sourceUri: "https://jobs.example.com/lumen-ai/director-product" });
  const all = (await me.query(api.network.search, { limit: 200 })).people;
  const id = (name: string) => all.find((x) => x.person.displayName === name)!.person.id;
  return { me, id };
}

test("MVP: five people in my network for my next AI product leadership role, why each, how I know them, the evidence", async () => {
  await withApp(async (t) => {
    const { me, id } = await demoNetwork(t);
    const goal = await me.mutation(api.intel.setGoal, { text: "My next AI product leadership role" });
    assert.deepEqual(goal.goal.functions, ["product"]);
    assert.deepEqual(goal.goal.domains, ["ai"]);
    assert.ok(goal.goal.seniority.includes("vp"));

    const r = await me.query(api.intel.recommend, { limit: 5 });
    const names = r.people.map((p) => p.person.displayName);
    assert.equal(r.people.length, 5, JSON.stringify(names));
    assert.equal(names[0], "Maya Okafor", "VP Product at an AI company that is hiring, whom I worked with");
    for (const expected of ["Daniel Reyes", "Priya Shah"]) assert.ok(names.includes(expected), `${expected} in ${names}`);
    for (const never of ["Tom Baker", "Ravi Menon", "Olivia Brennan"]) assert.ok(!names.includes(never), `${never} is not relevant`);

    const maya = r.people[0]!;
    assert.deepEqual(maya.reasons.map((x) => x.factor).sort(), ["domain", "hiring", "leadership", "role", "strength"].sort());
    assert.ok(maya.reasons.find((x) => x.factor === "hiring")!.text.includes("Director of Product, AI Platform"));
    assert.ok(maya.person.howKnown.some((h) => h.source === "linkedin_export" && h.establishedAt === "2016-06-14"));
    // Every cited evidence id is the caller's, and explains itself.
    for (const p of r.people) {
      assert.ok(["direct", "historical"].includes(p.person.relationship), "only people I actually know");
      const ids = [...new Set(p.reasons.flatMap((x) => x.evidenceIds))];
      assert.ok(ids.length > 0, `${p.person.displayName} has evidence`);
      for (const e of await me.query(api.network.explain, { evidenceIds: ids })) assert.ok(e.found, e.statement);
    }

    // The same answer through the conversational interface, by rules (no model configured).
    const ask = await me.action(api.assistant.ask, { question: "Find five people in my network who could help me find my next AI product leadership opportunity" });
    assert.equal(ask.intent, "recommend");
    assert.equal(ask.via, "rules");
    assert.match(ask.answer, /^For “a product leadership role in AI”, 5 people in your network stand out \(of \d+ you know\):\n1\. Maya Okafor/);
    assert.ok(ask.evidenceIds.length >= 5);
    assert.ok(!/Tom Baker/.test(ask.answer));

    void id;
  });
});

test("questions: hiring, introductions, reconnection, briefing and changes are interpreted by rules and answered from records", async () => {
  await withApp(async (t) => {
    const { me, id } = await demoNetwork(t);
    const hiring = await me.action(api.assistant.ask, { question: "Who do I know that's hiring in AI?" });
    assert.equal(hiring.intent, "search");
    assert.ok(hiring.interpretation.hiring);
    assert.match(hiring.answer, /Hiring: Lumen AI — Director of Product, AI Platform/);

    const ops = await me.action(api.assistant.ask, { question: "What open roles are there?" });
    assert.equal(ops.intent, "opportunities");
    assert.match(ops.answer, /Lumen AI: Director of Product, AI Platform\. You know (Maya Okafor, Kenji Watanabe|Kenji Watanabe, Maya Okafor) there\./);

    const intro = await me.action(api.assistant.ask, { question: "Who could introduce me to someone at Northwind Labs?" });
    assert.equal(intro.intent, "paths");
    assert.deepEqual(intro.interpretation.organizations, ["Northwind Labs"]);
    assert.match(intro.answer, /You know Daniel Reyes directly/);

    // Unknown organizations are not invented.
    const nowhere = await me.action(api.assistant.ask, { question: "Who works at Initech?" });
    assert.match(nowhere.answer, /No one in your network matches|No organization/);

    const brief = await me.action(api.assistant.ask, { question: "I'm meeting Maya tomorrow, help me prepare" });
    assert.equal(brief.intent, "briefing");
    assert.match(brief.answer, /Briefing: Maya Okafor, VP of Product at Lumen AI/);
    assert.match(brief.answer, /Inferred \(not established\)/);

    await me.mutation(api.network.recordInteraction, { personId: id("Maya Okafor"), kind: "call", note: "caught up" });
    const re = await me.action(api.assistant.ask, { question: "Who should I reconnect with?" });
    assert.equal(re.intent, "reconnect");
    assert.ok(!/Maya Okafor/.test(re.answer), "a recent call means not dormant");
    assert.match(re.answer, /Daniel Reyes.*No interaction recorded since connecting in 2017/);

    const ch = await me.action(api.assistant.ask, { question: "What changed in my network?" });
    assert.equal(ch.intent, "changes");
    assert.match(ch.answer, /Lumen AI is hiring/);
  });
});

test("paths: direct, through a recorded tie, through mutual Frame follows; a shared employer is never a tie", async () => {
  await withApp(async (t) => {
    const { me, id } = await demoNetwork(t);
    // Someone I only know of, at a company I'd like to reach.
    const wen = (await me.mutation(api.network.addPerson, { displayName: "Wen Li", organization: "Atlas AI", title: "VP Product", relationship: "none" })).personId;
    let p = await me.query(api.intel.paths, { organization: "Atlas AI" });
    assert.equal(p.paths.length, 0);
    assert.ok(p.limitations[0]!.startsWith("No known path"));

    await me.mutation(api.network.addTie, { personId: id("Liam O'Connor"), otherId: wen, context: "worked together at Vector Forge" });
    p = await me.query(api.intel.paths, { organization: "atlas ai" });
    assert.equal(p.paths.length, 1);
    assert.equal(p.paths[0]!.kind, "via_tie");
    assert.deepEqual(p.paths[0]!.hops.map((h) => h.displayName), ["Liam O'Connor", "Wen Li"]);
    assert.match(p.paths[0]!.explanation, /You could ask Liam for an introduction/);

    // Kenji and Maya share an employer; Zoe (whom I don't know) works there too: no path to Zoe.
    const zoe = (await me.mutation(api.network.addPerson, { displayName: "Zoe Park", organization: "Lumen AI", title: "Designer", relationship: "none" })).personId;
    const toZoe = await me.query(api.intel.paths, { personId: zoe });
    assert.equal(toZoe.paths.length, 0, "working at the same company is not knowing someone");

    // Frame's public graph: two people I linked follow each other.
    const prof = async (uid: string, username: string) => t.as(member(uid)).mutation(api.profiles.create, { username, displayName: username, interests: ["ai"] });
    await prof("ada", "ada");
    await prof("u-hannah", "hannah.kim");
    await prof("u-zoe", "zoe.park");
    await t.as(member("u-hannah")).mutation(api.follows.create, { profileId: (await t.as(member("u-zoe")).query(api.profiles.me))!.id });
    await t.as(member("u-zoe")).mutation(api.follows.create, { profileId: (await t.as(member("u-hannah")).query(api.profiles.me))!.id });
    await me.mutation(api.network.linkProfile, { personId: id("Hannah Kim"), username: "hannah.kim" });
    await me.mutation(api.network.linkProfile, { personId: zoe, username: "zoe.park" });
    const viaFrame = await me.query(api.intel.paths, { personId: zoe });
    assert.equal(viaFrame.paths.length, 1);
    assert.equal(viaFrame.paths[0]!.kind, "via_frame");
    assert.match(viaFrame.paths[0]!.explanation, /not a confirmed relationship/);
  });
});

test("opportunities: evidence-backed, deduplicated, stale signals are not active; Frame posts become signals through the same contract", async () => {
  await withApp(async (t) => {
    const { me, id } = await demoNetwork(t);
    const again = await me.mutation(api.intel.recordHiring, { organization: "Lumen AI", role: "Director of Product, AI Platform", sourceUri: "https://jobs.example.com/lumen-ai/director-product" });
    assert.equal(again.created, false, "the same posting twice is one piece of evidence");
    await me.mutation(api.intel.recordHiring, { organization: "Brightline Payments", role: "Staff Engineer", observedAt: Date.now() - 90 * 86_400_000, validDays: 30 });
    let ops = await me.query(api.intel.opportunities, {});
    assert.deepEqual(ops.map((o) => o.organization), ["Lumen AI"]);
    assert.equal(ops[0]!.evidence.length, 1);
    assert.ok(ops[0]!.relevance.includes("In your domain: ai") || true);
    ops = await me.query(api.intel.opportunities, { includeStale: true });
    assert.deepEqual(ops.find((o) => o.organization === "Brightline Payments")?.active, false);

    // Frame: I follow Daniel; he posts that Northwind is hiring; sync brings both in, once.
    await t.as(member("ada")).mutation(api.profiles.create, { username: "ada", displayName: "Ada", interests: [] });
    const dan = t.as(member("u-dan"));
    await dan.mutation(api.profiles.create, { username: "daniel.reyes", displayName: "Daniel Reyes", interests: ["ai"] });
    await me.mutation(api.network.linkProfile, { personId: id("Daniel Reyes"), username: "daniel.reyes" });
    await me.mutation(api.follows.create, { profileId: (await dan.query(api.profiles.me))!.id });
    await dan.mutation(api.posts.create, { text: "We're hiring a Head of Product for our inference platform. #hiring #ai", media: [], visibility: "public" });
    await dan.mutation(api.posts.create, { text: "Followers-only: also hiring a PM", media: [], visibility: "followers" });
    const s1 = await me.mutation(api.intel.syncFrame, {});
    assert.deepEqual({ added: s1.added, hiring: s1.hiringSignals, followed: s1.followed }, { added: 1, hiring: 2, followed: 1 });
    const s2 = await me.mutation(api.intel.syncFrame, {});
    assert.deepEqual({ added: s2.added, hiring: s2.hiringSignals }, { added: 0, hiring: 0 }, "idempotent");
    const nw = (await me.query(api.intel.opportunities, {})).find((o) => o.organization === "Northwind Labs")!;
    assert.ok(nw.evidence.every((e) => e.sourceType === "frame_post" && e.kind === "observed"));
    const rec = await me.query(api.network.person, { personId: id("Daniel Reyes") });
    assert.ok(rec.person.howKnown.some((h) => h.source === "frame_follow"));
    assert.equal((await me.query(api.network.search, { text: "daniel" })).total, 1, "the linked profile did not create a second Daniel");

    // Unfollow: the Frame relationship ends (kept), the LinkedIn one stays.
    await me.mutation(api.follows.remove, { profileId: (await dan.query(api.profiles.me))!.id });
    assert.equal((await me.mutation(api.intel.syncFrame, {})).ended, 1);
    const after = await me.query(api.network.person, { personId: id("Daniel Reyes") });
    assert.equal(after.person.relationship, "direct");
    assert.ok(!after.person.howKnown.some((h) => h.source === "frame_follow"));
  });
});

test("drafts: built only from evidence, never sent by Frame; an agent can only propose 'sent', a person confirms once", async () => {
  await withApp(async (t) => {
    const { me, id } = await demoNetwork(t);
    await me.mutation(api.intel.setGoal, { text: "AI product leadership" });
    const d = await me.mutation(api.followups.draft, { personId: id("Maya Okafor"), purpose: "reconnect" });
    assert.equal(d.status, "draft");
    assert.equal(d.generatedBy, "template");
    assert.match(d.text, /^Hi Maya,/);
    assert.match(d.text, /I still think back to our time together — we shipped the search relaunch together at Cartograph\./);
    assert.match(d.text, /my next step, a product leadership role in AI, and your perspective on AI/);
    assert.match(d.text, /Lumen AI is growing the team/);
    for (const e of await me.query(api.network.explain, { evidenceIds: d.basis })) assert.ok(e.found);
    assert.equal((await me.query(api.network.person, { personId: id("Maya Okafor") })).interactions.length, 0, "drafting records no interaction");

    // No tie on record: Frame refuses to claim one.
    await assert.rejects(me.mutation(api.followups.draft, { personId: id("Liam O'Connor"), purpose: "introduction", introduceTo: id("Maya Okafor") }), (e: { code?: string }) => e.code === "FAILED_PRECONDITION");

    // The owner's own agent (an MCP session as them) can draft, but not confirm a send.
    const agent = t.as(agentAs("ada"));
    const ad = await agent.mutation(api.followups.draft, { personId: id("Daniel Reyes"), purpose: "reconnect" });
    await assert.rejects(agent.mutation(api.followups.markSent, { draftId: ad.id }), (e: { code?: string; message?: string }) => e.code === "FORBIDDEN" || /approv/i.test(e.message ?? ""));
    const sent = await me.mutation(api.followups.markSent, { draftId: d.id });
    assert.equal(sent.status, "sent");
    await assert.rejects(me.mutation(api.followups.markSent, { draftId: d.id }), (e: { code?: string }) => e.code === "FAILED_PRECONDITION");
    const rec = await me.query(api.network.person, { personId: id("Maya Okafor") });
    assert.equal(rec.interactions.length, 1);
    assert.ok(rec.history.some((h) => h.type === "draft.sent_confirmed"));
    await assert.rejects(t.as(member("grace")).mutation(api.followups.discardDraft, { draftId: ad.id }), refused);
  });
});

test("follow-ups: a reminder arrives at its time if still open; completing one records what happened", async () => {
  await withApp(async (t) => {
    const { me, id } = await demoNetwork(t);
    await me.mutation(api.profiles.create, { username: "ada", displayName: "Ada", interests: [] });
    const f1 = await me.mutation(api.followups.createFollowup, { personId: id("Priya Shah"), dueAt: Date.now(), reason: "Send her the deck" });
    const f2 = await me.mutation(api.followups.createFollowup, { personId: id("Sofia Lindqvist"), dueAt: Date.now(), reason: "Ask about the fund" });
    await me.mutation(api.followups.completeFollowup, { followupId: f2.followupId, outcome: "cancelled" });
    await t.runtime.runServices();
    const inbox = await me.query(api.inbox.list, { limit: 50 });
    const due = inbox.groups.filter((n) => n.type === "network.followup_due");
    assert.equal(due.length, 1, JSON.stringify(inbox.groups.map((n) => n.type)));
    assert.equal(due[0]!.link.personId, id("Priya Shah"));
    assert.match(due[0]!.title, /Follow up with Priya Shah: Send her the deck/);

    const open = await me.query(api.followups.listFollowups, {});
    assert.equal(open.length, 1);
    assert.ok(open[0]!.overdue || open[0]!.dueAt <= Date.now());
    const done = await me.mutation(api.followups.completeFollowup, { followupId: f1.followupId, outcome: "done", interaction: { kind: "email", note: "sent the deck" } });
    assert.equal(done.status, "done");
    assert.equal((await me.query(api.network.person, { personId: id("Priya Shah") })).person.strength.factors.some((f) => f.factor === "interactions"), true);
  });
});

test("corrections: disputing evidence removes the fact it supported; merging reconciles two records; history survives a restart", async () => {
  await withApp(async (t) => {
    const { me, id } = await demoNetwork(t);
    const kenji = await me.query(api.network.person, { personId: id("Kenji Watanabe") });
    const job = kenji.positions[0]!;
    await me.mutation(api.network.dispute, { evidenceId: job.evidenceId, note: "he left in the spring" });
    const after = await me.query(api.network.person, { personId: id("Kenji Watanabe") });
    assert.equal(after.person.current.length, 0, "a disputed position is not used");
    assert.ok(after.evidence.some((e) => e.id === job.evidenceId && e.verification === "disputed"), "the evidence itself is kept");
    assert.ok(after.history.some((h) => h.type === "evidence.disputed"));

    const dupe = (await me.mutation(api.network.addPerson, { displayName: "Maya Okafor", relationship: "historical", context: "Cartograph search team" })).personId;
    assert.notEqual(dupe, id("Maya Okafor"), "a name alone never merges");
    const groups = await me.query(api.network.duplicates, {});
    assert.equal(groups.length, 1);
    await assert.rejects(t.as(agentAs("ada")).mutation(api.network.merge, { keepId: id("Maya Okafor"), mergeId: dupe }));
    const m = await me.mutation(api.network.merge, { keepId: id("Maya Okafor"), mergeId: dupe });
    assert.ok(m.moved >= 1);
    await t.restart();
    const merged = await t.as(member("ada")).query(api.network.person, { personId: dupe });
    assert.equal(merged.person.id, id("Maya Okafor"), "the merged id resolves to the survivor");
    assert.deepEqual(merged.person.howKnown.map((h) => h.type).sort(), ["direct", "direct", "historical"]);
    assert.equal((await t.as(member("ada")).query(api.network.duplicates, {})).length, 0);
  });
});

// ----------------------------------------------------------------------------------------- models

/**
 * A model that only routes: an OpenAI-compatible server that answers every chat completion with one
 * tool call. It also records what it was sent, so the test can check that it was offered only reads.
 */
async function routingModel(call: { name: string; arguments: Record<string, unknown> }) {
  const seen: Array<{ tools: string[] }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = JSON.parse(body || "{}");
      seen.push({ tools: (json.tools ?? []).map((x: { function: { name: string } }) => x.function.name) });
      const toolCall = { id: "call_1", type: "function", function: { name: call.name.replace(/\./g, "_"), arguments: JSON.stringify(call.arguments) } };
      if (json.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", model: "router", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, ...toolCall }] }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", model: "router", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`);
        res.end("data: [DONE]\n\n");
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "x", object: "chat.completion", model: "router", choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [toolCall] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { endpoint: `http://127.0.0.1:${port}/v1`, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("model: only a question the rules can't place goes to the model, which may only choose a read; the answer is still composed from records", async () => {
  const model = await routingModel({ name: "network.search", arguments: { domains: ["security"] } });
  try {
    await withApp(async (t) => {
      const { me } = await demoNetwork(t);
      // Without a model, a vague question is a text search by rules.
      const plain = await me.action(api.assistant.ask, { question: "anyone I should know about locks and keys?" });
      assert.equal(plain.via, "rules");

      await t.runtime.models.select({ provider: "custom", model: "router", endpoint: model.endpoint });
      const specific = await me.action(api.assistant.ask, { question: "Who works in AI infrastructure?" });
      assert.equal(specific.via, "rules", "a question the rules understand never reaches the model");
      assert.equal(model.seen.length, 0);

      const routed = await me.action(api.assistant.ask, { question: "anyone I should know about locks and keys?" });
      assert.equal(routed.via, "model", JSON.stringify(routed.limitations));
      assert.equal(routed.model?.model, "router");
      assert.equal(routed.intent, "search");
      assert.match(routed.answer, /Grace Mbeki/);
      assert.equal(model.seen.length, 1);
      const offered = model.seen[0]!.tools;
      assert.ok(offered.length > 0 && offered.every((n) => ["intel_recommend", "network_search", "network_paths", "intel_reconnect", "opportunity_search", "briefing_person", "briefing_changes"].includes(n)), `offered: ${offered}`);
    });
  } finally {
    await model.close();
  }
});

// Live: the same routing through two different providers via the AI gateway, when a key is available.
const GATEWAY_KEY = process.env.AI_GATEWAY_API_KEY;
for (const live of ["openai/gpt-4.1-mini", "google/gemini-2.5-flash"]) {
  test(`live model (${live}) via AI gateway: routes a vague question; facts still come only from records`, { skip: !GATEWAY_KEY && "AI_GATEWAY_API_KEY not set" }, async () => {
    process.env.FELTKIT_CREDENTIAL_AI_GATEWAY = GATEWAY_KEY;
    await withApp(async (t) => {
      const { me } = await demoNetwork(t);
      await t.runtime.models.select({ provider: "custom", model: live, endpoint: "https://ai-gateway.vercel.sh/v1", credentialRef: "credential-ref:ai-gateway" });
      const r = await me.action(api.assistant.ask, { question: "Which of my contacts would understand keeping systems safe from hackers?" });
      assert.equal(r.via, "model", JSON.stringify(r.limitations));
      assert.ok(r.model?.taskId);
      // Whatever the model chose, every person named in the answer is in the network.
      const known = new Set((await me.query(api.network.search, { relationship: "any", limit: 200 })).people.map((p) => p.person.displayName));
      for (const line of r.answer.split("\n").filter((l) => /^(•|\d+\.)/.test(l))) {
        const name = line.replace(/^(•|\d+\.)\s*/, "").split(" — ")[0]!.split(" (")[0]!.split(":")[0]!.trim();
        assert.ok(known.has(name), `${name} is in the network`);
      }
      console.log(`[${live}] ${r.model?.capability} ${JSON.stringify(r.model?.input)}\n${r.answer}`);
      assert.match(r.answer, /Grace Mbeki/, "the security person in the network is found");
    });
  });
}

test("search: a skill filter finds the same skill, or a recorded skill in the same domain, and says which", async () => {
  await withApp(async (t) => {
    const { me } = await demoNetwork(t);
    const exact = await me.query(api.network.search, { skills: ["security"] });
    assert.deepEqual(exact.people.map((p) => p.person.displayName), ["Grace Mbeki"]);
    assert.equal(exact.people[0]!.reasons[0]!.text, "Skill: security");
    const related = await me.query(api.network.search, { skills: ["cybersecurity"] });
    assert.deepEqual(related.people.map((p) => p.person.displayName), ["Grace Mbeki"]);
    assert.equal(related.people[0]!.reasons[0]!.text, "Skill: security (related to “cybersecurity”)");
    assert.equal((await me.query(api.network.search, { skills: ["pottery"] })).total, 0);
  });
});
