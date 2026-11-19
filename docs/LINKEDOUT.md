# LinkedOut — personal professional intelligence on Frame

LinkedOut is Frame extended, not a second application: the same FeltKit app (`name: "frame"`, so an
existing Frame deployment upgrades in place), the same accounts, roles, profiles, follows, posts,
notifications, jobs, MCP endpoint and agent model. It adds a private, evidence-backed professional
network per person and the intelligence over it.

This document is the build record: what Phase 0 found, what was built against the specification, what
was verified and how, what was measured, and what is not done.

## 1. Phase 0 — baseline (before any code)

Read from the code and the installed packages, not from descriptions.

| Area | Finding | Used how |
|---|---|---|
| Repositories | `rkendel1/linkedout` held Frame 1 (5 collections); `rkendel1/frame` @ `ce505e4` is Frame 2 (agents, delegation, communities, threads, reactions) | linkedout brought to `frame@ce505e4` first (commit `a281400`), then extended |
| Platform | `@feltdb/feltkit` 0.3.34, FeltDB 0.22.0, `@authboundry/local` 0.1.0 | — |
| Frame baseline tests | **18 / 20.** The 2 delegation tests fail: published `@authboundry/local` 0.1.0 has no per-agent registration (the fix is an unreleased authboundry commit, FRAME-GAP-12, `docs/PLATFORM-NEXT.md`). Delegation fails closed. Frame's seed also stopped there | Recorded, not worked around; the seed now reports it and continues |
| Identity | Principals (accounts, agent sessions); one Frame profile per principal | LinkedOut records are owned by the **principal id**, so the owner's own MCP agent operates the same network |
| Authorization | Roles on every interface; `owner` declarations per function (FeltKit 0.3.30); `approval: "required"` for agent-proposed mutations | Network functions: `network.read`/`network.write`; `owner` on every id-taking mutation; approval on merge and "sent" |
| Search | `ctx.db.search` (bounded scan, ≤ 100), `in` sets, ordered indexes; no joins, no array-element index | Indexed lookups for resolution; a per-request owner graph (§4) for relevance and paths |
| Audit | `app.auditTrail` (transactional, actor, request id, per-subject seq) | `networkLedger`: each person record's history |
| Jobs / notifications | Transactional `afterCommit` jobs and notifications | Follow-up reminders |
| Model | `app.action` + `ctx.model.generate` (durable generation records; OpenAI-compatible and Anthropic protocols; Intelligence selection or Resolver) + `ctx.agent.propose` | The assistant's optional routing step |
| MCP | Capabilities with `returns` become tools, filtered by the caller's authority | 39 LinkedOut tools |

## 2. Implementation map (specification → code)

| Spec | Built | Where |
|---|---|---|
| §5 Relationship model: direct / historical / suggested; second-degree and public computed | Yes. One relationship per source; second-degree via recorded ties and mutual Frame follows only | `relationships`, `ties` (app.ts); `intel.paths` |
| §5 Explainable strength, no popularity | Yes: owner's rating, recorded history, interactions in the past year, recency, introductions, mutual Frame follow; "unknown" when nothing is recorded | `strength()` in `_graph.ts` |
| §6 Person, Organization, Employment, Skill, time-aware | Yes. New job = new employment; previous one ends citing the evidence that ended it | `people`, `organizations`, `employments`, `personSkills`; `observePosition` |
| §6 Interest | Frame profile interests, used for shared interests in briefings | `intel.briefing` |
| §7 Evidence with provenance, kinds, validity, immutability | Yes. Unique content hash per owner; only `verification`/`supersededBy` change, recorded in the ledger | `evidence`, `addEvidence`, `evidence.dispute` |
| §8 Deterministic engine | Entity resolution, traversal, classification, freshness, dedupe, opportunity status, authorization, state transitions, corrections: all rules | `_network.ts`, `_graph.ts`, `_interpret.ts` |
| §8 AI only where it helps | Model routes questions the rules can't place (one read capability, contract-validated, one correction turn). Answers are composed from results, never by the model | `assistant.ts` |
| §9 Capability catalog | 39 capabilities (names map: `network.get_person` → `network.person`, `network.relationship_path` → `network.paths`, `briefing.generate` → `briefing.person` / `briefing.changes`; AppPort names allow no `_`) | `network.ts`, `intel.ts`, `followups.ts` |
| §10 NL examples A–E | All five, by rules; tested | `tests/network.test.ts` "questions" |
| §11 Proposed → draft → approved → confirmed | Draft (never sent by Frame) → owner confirms sent (agents propose; a person approves) → interaction recorded | `message.*` |
| §12 Source adapters, one evidence contract | LinkedIn export, generic CSV, the owner's word, Frame follows, Frame public posts | `network.import`, `network.syncframe` |
| §13 Isolation, no cross-user disclosure | Every read and write owner-scoped; another owner's ids answer NOT_FOUND / FORBIDDEN; importing the same file builds separate records; tested | |
| §14 No new database / graph DB / vector DB / runtime | None added: FeltDB records, deterministic traversal | |
| §18 MVP 1–9 | All nine (below) | |

**MVP, step by step**, all exercised by tests against real FeltDB and in the running app:

1. Import an authorized connection list: LinkedIn `Connections.csv` as downloaded (notes preamble included), or any CSV.
2. Durable person and relationship records, with identifiers and provenance.
3. Roles and organization history, kept across job changes.
4. Search by role, skill, company, industry/domain.
5. Direct vs. indirect relationships (`howKnown`, `paths`).
6. Evidence on every discovered fact (`evidence.explain` explains any id an answer cites).
7. Natural-language questions (`assistant.ask`).
8. Contextual reconnection drafts (`message.draft`), built only from evidence (`basis`).
9. Follow-up tracking with a reminder notification at its time.

The demonstration the spec asked for: *"Find five people in my network who could help me find my next AI
product leadership opportunity"* returns Maya Okafor (VP Product at Lumen AI, which is hiring; worked
together), Daniel Reyes (CPO, AI infrastructure), Priya Shah (Head of Product, ML), Kenji Watanabe
(recruiter at the hiring AI company) and Liam O'Connor (engineering director in AI infrastructure, a
mentor), each with reasons, how you know them, strength, limitations and expandable evidence. The bakery
owner, the bank analyst and the operations head are not returned.

## 3. Decisions

- **Owner = principal, not profile.** A person's network does not require a Frame profile, and the person's
  own MCP agent session (`--id <them> --type agent --role member`) operates the same network.
- **No shared "public person" layer.** Organizations and people are per owner. Shared entities would raise
  disclosure questions (§13) the MVP doesn't need to answer. Cost: no cross-owner deduplication.
- **Second-degree = recorded ties or mutual Frame follows.** A shared employer is never a tie (tested). Frame
  follows are public in Frame; mutual follows are labelled "a public signal, not a confirmed relationship".
- **Opportunities are computed from hiring evidence**, not stored as a second record. There is no "saved
  opportunity" record yet.
- **Assistant: rules first.** The model is consulted only when the rules recognize nothing specific. It may only
  choose one read capability; FeltKit validates its arguments; the answer text is composed deterministically.
- **`member` gains `feltkit.agent.read/write`** so an assistant turn can be a FeltKit agent task (durable
  generation evidence) whose reads run as the person. This also shows `feltkit_agent_*` tools to a member's
  MCP session (LO-GAP-05).

## 4. Measures

| | Lines |
|---|---|
| New backend (`_network`, `_graph`, `_interpret`, `network`, `intel`, `followups`, `assistant`) | 2,287 |
| Data model added to `app.ts` (+ inbox link) | 258 |
| New UI (`src/network.tsx`) + shell/styles changes | 534 + 84 |
| New tests (`tests/network.test.ts`) | 482 |
| Seed (`scripts/seed-network.ts`) + demo data | 56 + 2 CSVs |
| Frame backend reused unchanged | 1,790 |
| New collections / audit trails | 13 / 1 |
| New capabilities (MCP tools) | 39 |
| New services, databases, runtimes | 0 (Intelligence service enabled; it was already part of FeltKit) |

Performance, measured on the development server in this container (local FeltDB), one owner with 1,500
generated connections:

| Operation | Time |
|---|---|
| Import 1,500 rows (one transaction) | **59 s** |
| Re-import of the same file | 26 ms |
| `intel.recommend` over 1,500 | 38 ms |
| `network.paths` | 21 ms |
| `network.search` (first, cold) | 534 ms |

## 5. Test evidence

`npm test`: **32 / 34** (Frame 18 / 20, LinkedOut 14 / 14). The 2 failures are Frame's pre-existing delegation tests (published AuthBoundry, §1).
`tests/network.test.ts`: **14 / 14**, run repeatedly:

- import, idempotent re-import, provenance on every fact
- resolution by LinkedIn URL across exports, job history kept, a name alone never merges
- isolation between owners (reads, writes, evidence, explain, dispute, roles, anonymous)
- the MVP query, with every cited evidence id explained
- NL questions: hiring, opportunities, introductions, unknown organizations, briefing, reconnection, changes
- paths: direct, recorded tie, mutual Frame follow; shared employer is not a tie
- opportunities: dedupe, staleness, Frame posts as evidence, idempotent sync, unfollow ends the relationship
- drafts: evidence-only, no implied send, agent can't confirm "sent", once only, isolation
- follow-ups: reminder via the job/notification path only while open
- corrections: dispute removes the fact it supported, merge (approval for agents), survives a restart
- related-skill search
- model routing with a local OpenAI-compatible fixture: never consulted when rules suffice; offered only reads
- **live** models through the AI gateway (when `AI_GATEWAY_API_KEY` is set): `openai/gpt-4.1-mini` and
  `google/gemini-2.5-flash` each route a question the rules can't place and the answer names only people in
  the network. Both passed in repeated runs, with different tool arguments.

Also verified by hand on the running app: the MVP flow in Chromium at desktop and phone width (no horizontal
overflow), and an MCP agent session as the owner listing the 39 tools, calling `intel_recommend`, and being
refused `network_merge` ("requires a person's approval").

## 6. Gap register (LinkedOut)

| ID | Gap | Owner | Severity | Now |
|---|---|---|---|---|
| LO-GAP-01 | Import of 1,500 rows takes 59 s in one request/transaction, with no progress | LinkedOut | Medium | Capped at 1,500 rows per file. Next: a job-based import with progress, chunked, the import record tracking state |
| LO-GAP-02 | No joins or graph queries: relevance and paths read the owner's whole network per request | FeltDB | Low now, Medium at scale | Fast at 1,500 (38 ms). A projection would be the next step, never authoritative |
| LO-GAP-03 | Per-agent delegation unavailable on published `@authboundry/local` 0.1.0 | AuthBoundry | High for Phase 4 | External actions (send e-mail, calendar) need it; Frame's own delegation tests fail on it today |
| LO-GAP-04 | Imported files are not kept as artifacts; only their hash and the per-row evidence | LinkedOut | Low | Next: store the file via AppPort Files, reference it from the import |
| LO-GAP-05 | Running a model turn as a person needs `feltkit.agent.write`, which also exposes FeltKit's operator agent tools to that person's MCP sessions | FeltKit | Medium | Granted to `member`; those tools still act only as the person. A narrower permission for "my own action turns" would remove the side effect |
| LO-GAP-06 | FeltKit's owner check answers FORBIDDEN "Only the owner of people <id> may do this", confirming an id exists | FeltKit | Low | LinkedOut's own reads answer NOT_FOUND; ids are random and only leak existence, not content |
| LO-GAP-07 | Free-tier AI gateway key refuses Anthropic models | Environment | Low | Live tests use OpenAI and Google through the OpenAI-compatible protocol; the Anthropic Messages path is not live-tested |
| LO-GAP-08 | `/api/events` answers 401 once before the development sign-in completes (console noise) | FeltKit client / Frame | Low | Cosmetic |

## 7. Not built (honestly)

- **Phase 2 public sources**: no job-board, company-site or announcement adapters. Hiring evidence comes from
  the owner's word (with a cited URL) and Frame posts. The evidence contract is ready for adapters.
- **Phase 4 integrations**: no Gmail or Calendar, no authorized external execution. Drafts are never sent by
  Frame; that is by design for the MVP, and execution needs LO-GAP-03 first.
- **Phase 5 proactive intelligence**: no scheduled refresh, no change alerts, no notification preferences for
  network alerts. `briefing.changes` exists on demand; follow-up reminders are the only proactive notification.
- **Saved opportunities**, **per-person interests as their own records**, **cross-owner public entities**, and an
  explicit **"reject suggestion"** workflow (suggested relationships exist in the model; nothing creates them yet).
- **e2e**: Frame's e2e suite (production build over HTTP, restart) was not extended to LinkedOut, and was not run
  in this session.

## 8. Run it

```bash
npm install && npm run dev
npm run seed && npm run seed:network        # Frame's demo, then LinkedOut's network for demo@frame.example
```

Open http://localhost:3000/network. The public demo seed (`npm run start:demo`) loads it for Ada.

To let the assistant use a model (optional): Studio → Models, or
`npx feltkit model set --provider custom --model openai/gpt-4.1-mini --endpoint https://ai-gateway.vercel.sh/v1 --credential credential-ref:ai-gateway`
with the key in `FELTKIT_CREDENTIAL_AI_GATEWAY`. Without one, every question is answered by rules.
