# Frame 2 — implementation report

Frame 2 turns Frame from a photo app into a social ecosystem where people and agents take part on
equal terms, on FeltKit 0.3.30. Every number below comes from a command in this repository.
Run on 2026-11-16.

## 1. Results

| Command | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm test` (`feltkit test`: real FeltDB, real private AuthBoundry, per test) | **15 / 15 pass** |
| `npm run test:e2e` (`feltkit build` + `feltkit start` on fresh state: HTTP, MCP, Chromium phone + desktop, restart) | **8 / 8 pass** |
| `feltkit build` | succeeds; reports `app.agent` not portable to AppBoundry (FRAME-GAP-13) |
| `npm run seed` against the production server | 9 people, 36 posts, 158 reactions, 43 comments, 4 Scout answers, a Concierge digest |
| `feltkit measure` | Infrastructure findings: **none**; generated API current |

**Negative controls.** A passing suite only means something if it fails when a guarantee is broken.
Removing the `owner` declaration from `posts.remove` failed 2 tests; making Concierge ignore
AuthBoundry's refusal failed the delegation test. Both were restored.

Not run: Docker (no daemon here), AppBoundry (Frame 2 is not buildable for it: FRAME-GAP-13).

## 2. Dependencies

| Package | Before | After | Notes |
|---|---|---|---|
| `@feltdb/feltkit` | 0.3.29 | **0.3.30** | published 2026-11-16; no changelog ships, so the public `.d.ts` files of both versions were diffed |
| `@appport/services` (via FeltKit) | 0.17.0 | **0.18.0** | `FileService.references`, paged `list` |
| `@authboundry/local` | — | **0.1.0** (new) | FeltKit's peer dependency for `authority.local`; brings `@authboundry/core` 1.18.0 |
| `@feltdb/core` | 0.21.0 | 0.21.0 | latest |
| `@appport/sdk`, `server`, `protocol`, `authorization`, `mcp`, `resolver-client`, … | as pinned | unchanged | all already at the latest versions FeltKit pins |
| `@feltdb/webllm`, `@mlc-ai/web-llm` | in `package.json` | **removed** | scaffold leftovers; nothing imported them |

The upgrade alone changed no behaviour: Frame 1's 10 tests passed on 0.3.30 before any Frame code
changed. FeltDB, Resolver and AppBoundry had nothing newer to adopt.

## 3. Platform capability audit (what 0.3.30 offers, and what Frame now uses)

| Capability (owner) | Used for | Evidence |
|---|---|---|
| FeltDB collections, references, unique constraints, indexes (FeltDB) | 10 collections; `(target, profileId)` makes duplicate reactions impossible | concurrency test (12 people + 8 duplicate taps → exact counts) |
| FeltDB migrations, run in the schema's transaction (FeltKit) | Frame 1 → 2 data: photos → `media`, likes → reactions, captions → text + topics, resident agents | `tests/migration.test.ts` runs Frame 1's own code from git, then Frame 2 on the same state |
| `owner` on functions (FeltKit, **new**) | every edit/delete/answer on someone's record | `posts:`, `comments:`, `tasks:`, `agents:` tests; negative control |
| `app.agent` (FeltKit) | Scout and Concierge run as their own principals after commit, leased and retried | Scout and delegation tests (activity `actorType: "agent"`, recorded by FeltKit) |
| `authority.local` + `ctx.authority.grants` / `decide` (FeltKit + AuthBoundry, **new**) | delegation decided at action time; revocation stops the next action | delegation tests, in-process and in production (e2e 4, 8) |
| `app.auditTrail` (FeltKit) | who did what, as whom, for whom, with AuthBoundry's ids | `activity.profile` assertions |
| AppPort Services Files | photos, avatars, single-use upload links, sandboxed downloads | e2e 1, 2 |
| AppPort Services Notifications | durable per-recipient inbox | notification tests |
| After-commit outbox (`notifications`, `jobs`, `agent`) | nothing is announced or run for a rolled-back write | job and agent tests |
| Jobs | photo release after delete; scheduled delegated posts | `posts:` and `delegation: … later` tests |
| Live queries | every screen; another person's comment appears without reload | e2e 7 |
| MCP with caller-filtered `tools/list` (FeltKit, **new**) | external agents | e2e 5 |
| Accounts, sessions, roles | people (`member`), agents (`agent`), resident agents (`resident`) | e2e 3, 5 |

Not used, with reasons: **invocations/surfaces** (for work from external entry points; see
GAP-REGISTER "Observed"); **integrations / per-person connections** (Frame calls no external API);
**model decisions** (`ctx.agent`/`ctx.model`): Frame's agents are deterministic, and nothing in them
needs a model to be correct. That is deliberate: Scout's answer is computed from Frame's records, and
Concierge's authority comes from AuthBoundry, not from a model's judgement.

## 4. Workarounds

| Workaround in Frame 1 | Frame 2 | Lines |
|---|---|---|
| `authorize` hook + function-name map (GAP-04) | **removed**, replaced by `owner` declarations | −8 (hook) |
| Photo link cache (GAP-01) | kept, platform unchanged | ≈ 23 |
| Per-author feed merge (GAP-05) | kept, FeltDB unchanged | ≈ 10 |
| Notification list sliced in memory (GAP-08) | kept and extended to cursor pages and grouping, platform unchanged | ≈ 20 |
| Photo release job (GAP-09) | kept; now relies on the platform's recorded byte release | ≈ 12 |

**Honest LOC summary.** `feltkit measure`: domain 504 → 1,605, experience 1,034 → 1,769,
infrastructure 163 → 199 (the seed script), tests 460 → 758; custom runtime infrastructure 0 → 0.
Frame grew because it does far more (agents, delegation, threads, reactions, notifications,
discovery). The workaround code did **not** shrink substantially: the platform closed one gap Frame
had worked around (04) and one it had not (10), and partly closed a third (09). The rest are still
open upstream, and the register says where. No platform capability was re-implemented in Frame.

## 5. Architecture and data model

```
feltkit/app.ts        roles, authority (local AuthBoundry), services, 10 collections, activity trail, migration
feltkit/_frame.ts     who the caller is, visibility, shapes, notify(), record()
feltkit/_social.ts    publish / comment / react — written once, used by people, MCP agents and resident agents
feltkit/posts.ts      posts, media links, feed, topics, search, photo release
feltkit/comments.ts   threads: create, reply, edit, tombstone delete
feltkit/reactions.ts  set / change / remove / who reacted
feltkit/follows.ts    follow / unfollow
feltkit/profiles.ts   people and agents
feltkit/inbox.ts      notifications: grouped, paged, read state, preferences, read-time privacy
feltkit/agents.ts     Scout (app.agent), sponsorship of external agents, directory, activity
feltkit/tasks.ts      delegation (grants), tasks, Concierge (app.agent)
feltkit/discover.ts   unified search, trending topics, capability catalog
```

| Collection | Key fields | Constraints |
|---|---|---|
| profiles | userId, username, kind (person/agent, from the verified principal), ownerId?, resident?, interests[], skills[] | unique userId, username |
| posts | authorId → profiles, text, visibility, topics[], viaAgentId? | indexes (authorId, createdAt), (visibility, createdAt) |
| media | postId → posts, fileId, width, height, position | **unique fileId** (an upload is published once) |
| postTopics | postId → posts, topic | index (topic, createdAt) |
| comments | postId → posts, authorId → profiles, parentId?, text, viaAgentId?, editedAt?, deletedAt? | indexes (postId, createdAt), parentId, authorId |
| reactions | postId → posts, target ("post:…"/"comment:…"), profileId → profiles, kind, viaAgentId? | **unique (target, profileId)** |
| follows | followerId, followeeId → profiles | unique pair |
| notificationSettings | profileId, muted[], fromAgents | unique profileId |
| sponsorships | agentId, personId → profiles, status | unique pair |
| tasks | ownerId, agentId → profiles, kind, capability, status, draft?, decisionId?, delegationId? | |
| activity (`app.auditTrail`) | actor, actorType, requestId, seq, data | FeltKit's |

**Attribution model.** A record's author is who it belongs to. When an agent acts for a person, the
record is the person's, with `viaAgentId` naming the agent, and both appear in the activity trail with
AuthBoundry's `decisionId`/`delegationId`. When an agent acts as itself, the record is the agent's.
FeltKit, not Frame, records the principal type of whoever made each call.

## 6. Feature inventory → implementation → test

| Capability | Implementation | Test |
|---|---|---|
| People and agents as profiles; kind from the verified principal | `profiles:create` | `profiles: people and agents…` |
| Multi-image and text posts, own uploads only, once | `posts:create`, `_social.publish` | `posts: several images…`; e2e 1, 7 |
| Edit / delete own posts | `posts:update/remove` + `owner` | `posts: …declared ownership` |
| Visibility (public / followers) on every read path, including images and mentions | `canSee`, `page`, `mediaLink` | `visibility: …every read path` |
| Threads: reply, edit, tombstone delete | `comments.ts` | `conversation: …` |
| Reactions on posts and comments: add, change, repeat, remove, counts, who | `reactions.ts`, `_social.react` | `reactions: …`, `concurrency: …`; e2e 6 |
| Notifications: 10 types, grouped, paged, read / read-all, preferences, deep links | `inbox.ts`, `notify()` | `notifications: …` |
| Notifications never reveal what the reader can no longer see | resolved at read time | `notifications never reveal…` |
| Scout: replies and reacts as itself where mentioned; respects visibility | `agents:scout` | two Scout tests; e2e 5 (agent → agent) |
| External agents over MCP, filtered discovery, sponsorship by a person | `agents:requestSponsor/respondSponsor` | `external agents: …`; e2e 5 |
| Delegation: grant, act, revoke, refused next time, asks the person, retry | `tasks.ts` | `delegation: …` (×2); e2e 4, 8 |
| Reviewable agent activity (public for agents, private for people) | `agents:activityOf` | Scout, external-agent and delegation tests |
| Discovery: people, agents, posts, topics; agent directory by what they did | `discover.ts`, `agents:directory` | profiles and visibility tests |
| Capability catalog read from the function definitions | `discover:capabilities` | `external agents: …` |
| Durability across restart; migration from Frame 1 | FeltDB | restart tests; `migration.test.ts`; e2e 8 |

## 7. Security and authorization tests

| Boundary | Proven by |
|---|---|
| Another person or agent cannot edit or delete your post or comment | `posts: …`, `conversation: …`, `external agents: …`; e2e 3, 5 |
| Unknown id is NOT_FOUND, others' is FORBIDDEN (ownership fails closed) | `posts: …` |
| No function takes an actor: a forged `profileId` argument is refused | e2e 3 |
| Anonymous calls refused | e2e 3 |
| Followers-only content invisible to non-followers on 11 read/write paths, including image links | `visibility: …` |
| Notifications cannot leak hidden or deleted content | `notifications never reveal…`, `conversation: …` |
| You cannot mark someone else's notifications | `notifications: …` |
| Only the asked person can answer a sponsorship; agents cannot delegate | `external agents: …` |
| Delegated action requires AuthBoundry's allow at the moment of action; revocation stops the next action; the refusal is recorded | `delegation: …`; e2e 4 |
| A task belongs to its owner (cancel, retry, the due job) | `delegation: …` |
| A resident agent sees only what a non-follower sees | `Scout respects visibility…` |
| Agents are not shown, and cannot call, person-only operations | e2e 5 |

Cross-tenant isolation: Frame is single-tenant (one community per deployment, no `auth.tenant`), so
there is no tenant boundary to test; per-person isolation is tested above.

## 8. The demonstration (WOW 1–15)

| # | Step | Where |
|---|---|---|
| 1–7 | post → comment → reply → reactions → notifications with deep links | `conversation: …`; e2e 7 (browser) |
| 8–10 | an agent joins the conversation as itself; attributed notification | Scout test; e2e 5 |
| 11 | another agent discovers capabilities and takes part | `external agents: …`; e2e 5 |
| 12 | a person delegates and reviews the actions | `delegation: …` (activity trail with delegation ids) |
| 13 | revoking authority stops the next action | `delegation: …`; e2e 4 |
| 14 | durable and attributable | restart tests, activity trail |
| 15 | no workaround for anything the platform now provides | §4 |

Screenshots (production build, seeded): `docs/screenshots/` — home (desktop, phone), a conversation
Scout joined, Scout's profile and its activity, the activity center (desktop, phone), the Agents page
with delegation and delegated work, Discover.

## 9. Follow-up work (2026-11-16, second pass)

**Frame** (on this branch, released platform):
- **Communities** (`feltkit/communities.ts`): open to people and agents; posting needs membership;
  joined communities reach the home feed once; owners and moderators take posts out; discovery and
  Scout point to them. Test: `communities: …`; e2e 5 (an MCP agent joins and posts).
- **Paged conversations**: by top-level comment through `(postId, root, createdAt)`, each page with its
  reply threads; tie-safe cursor, proven with a frozen clock and a negative control. Migration
  `frame 3`. Test: `conversations page by top-level comment…`.
- **A cancelled scheduled post releases its images**, unless another pending one still uses them.
  Test: `cancelling a scheduled post releases its images…`.
- Correction: `@feltdb/webllm` and `@mlc-ai/web-llm` were still in `package.json` although §2 said they
  were removed. They are removed now (commit `64283af`).

**Platform** (in the owning repositories, branch `claude/kind-pascal-56i8k8` in each, unreleased):

| Gap | Repository | Commit | Verified |
|---|---|---|---|
| 08 notification paging | appport-services | `110d72a` | 12 new tests; 429 / 429 suite |
| 05 set queries (`in`) | flow_db | `930bc64` | 10 new tests (bounded: 21 of 20,000 records a page); conformance on memory, file, IndexedDB, server |
| 12 per-agent delegation | authboundry | `001ce42` | 13 / 13 `@authboundry/local` (6 new) |
| 01 cacheable links, 06 image variants, 11 `decide` | feltkit | `23c59e0` | 9 + 2 new tests |
| wiring 05 / 08 / 12 into FeltKit | feltkit | `f49a40e` | 730 / 732 sdk suite with the upstream branches |

Frame's adoption of all of it, with the workarounds removed, is on the local branch `platform-next`
(see its `docs/PLATFORM-NEXT.md`): 20 / 20 integration and 8 / 8 e2e against builds of those commits.
It cannot be merged until the packages are published.

## 10. Remaining work, prioritised

1. **Release** `@appport/services`, `@feltdb/core`, `@authboundry/local`, then `@feltdb/feltkit`; merge `platform-next`.
2. ~~AuthBoundry security~~ **fixed** on authboundry's branch (`cb229b4`): creating an agent never
   overwrites a principal (no reactivating a revoked agent, no turning a person into one), and the
   local authority refuses to start with a revoked executor. 5 new Rust tests, 15 / 15 local.
3. ~~FeltDB ordering bug~~ **fixed** on flow_db's branch (`9e42687`, refined in `e45cc00`): queries with
   no `orderBy` return record-id order, reading only the matching index group. Frame 20 / 20 and 8 / 8
   on it.
4. FeltDB server / managed: `in` is answered correctly but as a scan, not a merge.
5. FeltKit: an unmerged branch `claude/notifications-pagination` adds `notifications.page()` too; keep
   `f49a40e`'s `page` / `unreadCount` / `markAllRead` and that branch's `list()` when merging.
6. Frame: array-membership queries (GAP-14); notification grouping across pages.
