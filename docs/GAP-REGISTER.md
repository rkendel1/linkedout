# Frame — platform gap register

Platform as installed: `@feltdb/feltkit` 0.3.30, `@appport/services` 0.18.0, `@feltdb/core` 0.21.0,
`@authboundry/local` 0.1.0 (with `@authboundry/core` 1.18.0), AppPort 1.x as pinned by FeltKit. Each
entry says what Frame needs, what the platform does (read from the installed code, not its
description), what Frame does instead, and the evidence. No platform package was modified: this
session can reach only the Frame repository, and none of these packages can be published from it.

Severity: **High**, blocks a core feature on a supported path. **Medium**, Frame works with a
workaround or a known cost. **Low**, friction.

## Status after the platform work on branch `claude/kind-pascal-56i8k8` (unreleased)

On this branch Frame uses the implementations described in [PLATFORM-NEXT.md](PLATFORM-NEXT.md):
FRAME-GAP-01, 05, 06, 08, 11 and 12 are **closed upstream (unreleased)** and their workarounds are removed
here. 02, 03, 07, 13 and 14 remain open. The tables below record the state on the published packages.

## Status of Frame 1's gaps after the upgrade

| ID | Gap | Owner | Status in 0.3.30 / 0.18.0 | Frame now |
|---|---|---|---|---|
| FRAME-GAP-01 | Photo links are uncacheable and new on every issue | Files | **Open.** `files.link` options unchanged; downloads still `private, no-store` | Client link cache kept (`src/lib.tsx`, `usePhotoUrl`). e2e asserts the header |
| FRAME-GAP-02 | AppBoundry artifacts cannot upload or serve files | AppBoundry | **Open** | Deploy with the Node/container target |
| FRAME-GAP-03 | AppBoundry artifacts cannot sign people up (FK-GAP-013) | AppBoundry | **Open** | Same |
| FRAME-GAP-04 | Per-record rules keyed by function-name strings | FeltKit | **Closed.** `owner` on the function (`OwnerDeclaration`, checked when declared, enforced on every interface) | **Workaround removed**: the `authorize` hook and its name→collection map are gone; 7 functions declare `owner`. Tests prove each, and a negative control (removing one declaration) fails 2 tests |
| FRAME-GAP-05 | No set membership in queries; a feed is a query per followed author | FeltDB | **Open.** `@feltdb/core` is still 0.21.0 | Per-author merge kept (`posts:feed`) |
| FRAME-GAP-06 | No image derivatives | Files | **Open** | Browser downscales to 1440 px before upload |
| FRAME-GAP-07 | Text search is a bounded scan | FeltDB | **Open** | None needed at this scale |
| FRAME-GAP-08 | Notifications list has no limit or cursor | AppPort Services | **Open.** `NotificationsReader.list({ unread, type })` is unchanged in 0.18.0; there is no `markAllRead` | `inbox:list` reads the caller's notifications and pages them in memory (cursor `createdAt|id`, tested to never skip or repeat); `markAllRead` marks one at a time |
| FRAME-GAP-09 | No after-commit file removal | Files / FeltKit | **Partly closed.** `files.remove` now records the byte release durably before deleting metadata, and keeps bytes another live file references (`FileService.references`, 0.18.0). It still commits on its own, outside the calling mutation's transaction | `media.release` job kept: it is what makes removal follow the delete's commit. Tested: both photos of a deleted 2-photo post are removed, by the owner |
| FRAME-GAP-10 | MCP `tools/list` shows tools the caller cannot call | FeltKit | **Closed.** `visibleTools` filters by the same authorizer as calls | Nothing to remove (Frame had no workaround). e2e: an agent sees no `feltkit_agent_*` tools and no person-only delegation tools; calling one directly is still refused |

About the previously identified workstreams: commit `8420e70` does not exist in this repository
(`git show 8420e70` fails; this repository's history is five Frame commits), so it was not repaired
here. What the published packages show of each workstream: **function-bound ownership** shipped
(FeltKit 0.3.30 `owner`, which names FRAME-GAP-04 in its own docs); **file deletion** shipped as
recorded byte release (FeltKit 0.3.30 + Services 0.18.0), without a transactional `afterCommit`
form; **notification pagination** is in no published version.

## New gaps found building Frame 2

| ID | Gap | Owner | Severity | Workaround |
|---|---|---|---|---|
| FRAME-GAP-11 | `ctx.authority.decide({ onBehalfOf })` does not apply `authority.principal`, though grants do | FeltKit | Low | One function (`authorityPrincipal`) used for both |
| FRAME-GAP-12 | Delegation is person → application executor; there is no person → specific agent grant | AuthBoundry / FeltKit | Medium | One capability name per resident agent (`concierge.*`); external agents cannot hold delegated authority |
| FRAME-GAP-13 | Application agents and the local authority cannot run in AppBoundry | AppBoundry | High (for that target) | Frame deploys with the Node/container target |
| FRAME-GAP-14 | No array-membership query (`interests` contains X) | FeltDB | Low | Scout and suggestions scan the newest 300 profiles |

### FRAME-GAP-11 — `decide` does not map the person
- **Platform:** `feltkit({ authority: { principal } })` maps an application principal to AuthBoundry's.
  `ctx.authority.grants` applies it (`authorityPrincipalOf`, `runtime/local-authority.js`); `decide`
  sends `onBehalfOf` as given (`runtime/application-authority.js`, line 51).
- **Evidence:** spike, before Frame's code was written: grant made, then `decide({ onBehalfOf: "ada" })`
  → `deny: delegation_missing`; with `"user:ada"` → `allow` with the delegation id; after revoke →
  `deny: delegation_revoked`.
- **Workaround:** `authorityPrincipal` in `feltkit/app.ts` is both the config's `principal` and what
  Concierge passes to `decide`. A test (`delegation: …`) fails if they diverge.
- **Recommended:** `decide` maps `onBehalfOf` through `authority.principal` (or takes an application
  principal id).

### FRAME-GAP-12 — no per-agent delegation
- **Platform:** the local AuthBoundry has one executor (`authority.executor`, the application), and
  `grants.grant({ capabilities })` grants it capabilities from a static list (`authority.capabilities`).
- **Consequence:** a grant cannot name *which* agent may act. Frame scopes by capability name
  (`concierge.publish`, …), which works for agents the application declares, and cannot work for agents
  that arrive at run time over MCP. An external agent acts only as itself.
- **Recommended:** executors registered per agent (AuthBoundry agent registration), with grants naming
  the executor; or a `resource`/`executor` field on grants that `decide` matches.

### FRAME-GAP-13 — AppBoundry cannot host Frame 2
- `feltkit build` reports `app.agent("scout", "concierge")` as not portable to `--target appboundry`
  ("the AppBoundry host protocol has no way to run guest code as another principal after a call"),
  and `docs/TRANSACTIONS.md` §8 says the build refuses it. Frame 1's AppBoundry test was removed with
  the feature it tested: an artifact of Frame 2 is not buildable, and files and sign-up were already
  missing there (02, 03).

### FRAME-GAP-14 — no array-membership query
- `where` supports equality and ranges. "Profiles interested in #film" is a bounded scan
  (`agents:scout`, `profiles:suggested`). Fine at demo scale; an index on array elements, or a
  `profileInterests` collection, at growth.

## Observed, not gaps

- **Production delegation needs an operator key.** In production, the local AuthBoundry keeps its
  secrets in FeltKit's credential vault, which is opt-in: without `FELTKIT_CREDENTIAL_VAULT=1` and
  `FELTKIT_CREDENTIAL_VAULT_KEY`, the server logs "The local authority did not start" and every
  delegated action is refused (fail closed). The e2e suite sets both and proves grant, allow, revoke,
  refuse, and that a revocation survives a restart.
- **Delegated tasks are Frame records, not FeltKit invocations.** FeltKit's invocation lifecycle is for
  work arriving from registered surfaces; its own documentation keeps "tasks and results in the
  application's collections", an invocation is visible only to the person and the deliverer (not to an
  agent doing the work), and live queries are not notified of its changes. AuthBoundry remains the
  authority; the task record holds its decision and delegation ids as evidence.
- **Session issuance in production needs an operator** (unchanged from Frame 1; the e2e test follows it).
- **Docker** was not run (no daemon here). The container target is unchanged from Frame 1.
