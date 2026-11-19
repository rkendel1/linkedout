# Frame on the next platform release

This branch moves Frame onto platform capabilities that were implemented in their owning packages
and are **not published yet**. It is verified against builds of these exact commits; it does not
install from npm until they are released.

| Package | Repository @ branch `claude/kind-pascal-56i8k8` | Commit | What Frame uses |
|---|---|---|---|
| `@feltdb/feltkit` | rkendel1/feltkit | `f49a40e` (on `23c59e0`) | cacheable links, image variants, `decide` mapping, `ctx.db` `in`, `notifications.page/unreadCount/markAllRead`, per-agent grants |
| `@appport/services` | rkendel1/appport-services | `110d72a` | inbox paging, unread count, mark-all-read (contract v4) |
| `@feltdb/core` | rkendel1/flow_db | `e45cc00` (on `930bc64`, `9e42687`) | `in` conditions, ordered index merge; queries with no `orderBy` return record-id order and read only the matching index group |
| `@authboundry/local` | rkendel1/authboundry | `cb229b4` (on `001ce42`) | per-agent registration and grants; creating an agent never overwrites a principal (security) |

## What changed in Frame, and the workaround each removes

| Gap | Before | Now |
|---|---|---|
| FRAME-GAP-01 photo links | a browser-side link cache (`usePhotoUrl` Map) | `files.link(…, { cache: true })`: one URL per caller and photo within a window, `private, max-age, immutable`, ETag / 304 |
| FRAME-GAP-05 feed | one query per followed author, merged | one `authorId in [...]` query (and one `communityId in [...]`), an index merge over `(authorId, createdAt desc)` reading about one page |
| FRAME-GAP-06 sizes | full images in grids and avatars | declared variants `grid`, `feed`, `avatar`, derived once by FeltKit |
| FRAME-GAP-08 inbox | every notification read, sorted and sliced in memory | `notifications.page` (bounded, indexed, opaque cursor), `unreadCount` ("99+"), `markAllRead` |
| FRAME-GAP-11 `decide` | `authorityPrincipal()` used by hand | `onBehalfOf: userId`, mapped by FeltKit |
| FRAME-GAP-12 delegation | capability names per agent (`concierge.*`) granted to the application | `frame.publish` / `frame.react` / `frame.digest` granted **to Concierge** by name; Concierge decides as itself with its own credential |

Migration `frame 4` renames task capabilities `concierge.*` → `frame.*`. Grants made before this branch
were made to the application's executor under the old names: they no longer apply, and people grant
again (the Agents page shows every permission as not granted).

## How it was verified

```bash
# Build tarballs of the four commits (FeltKit's branch report has the recipe), then:
#   "@feltdb/feltkit": "file:…/feltdb-feltkit-0.3.30.tgz",
#   "@appport/services": "file:…/appport-services-0.19.0-paging-110d72a.tgz",
#   "@feltdb/core": "file:…/feltdb-core-0.21.0-in-930bc64.tgz",
#   "@authboundry/local": "file:…/authboundry-local-0.1.0-agents-001ce42.tgz"
npm install && npm test && npm run test:e2e
```

Results on 2026-11-16: `tsc` clean; **20 / 20** integration tests (two new: the feed's index merge
proven with `explain` and examined-record counts; stable cached links and sizes); **8 / 8** e2e on the
production build (cache headers, 304, a derived `grid` image over HTTP, per-agent delegation decided
by the production AuthBoundry, revocation surviving a restart).

Re-verified with FeltDB `e45cc00`: 20 / 20 and 8 / 8. With `9e42687` alone, four of Frame's reads with no
`orderBy` (follows by follower, comments by post, memberships by community, posts by author) became full
scans; `e45cc00` reads only the matching index group instead (`index-group`, proven with `explain`).

## Before merging this into main

1. Release the four packages (versions are the owners' call), with FeltKit's floors raised as its
   CHANGELOG lists.
2. Set `package.json` here to those versions, `npm install`, and rerun both suites.
