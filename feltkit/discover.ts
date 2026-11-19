/**
 * Discovery: one search over people, agents, posts and topics; trending topics; and the capability
 * catalog, which tells a caller (person or agent) what Frame can do, what each operation needs, and
 * whether the caller holds it. The catalog is read from the functions' own definitions, so it cannot
 * drift from what the server enforces. Discovery grants nothing: each call is authorized again.
 */
import { s } from "@feltdb/feltkit";
import { DELEGABLE, app, communities, postTopics, posts, profiles } from "./app.js";
import { Author, GridItem, author, canSee, gridItems, myProfile } from "./_frame.js";
import * as agentsModule from "./agents.js";
import * as commentsModule from "./comments.js";
import * as communitiesModule from "./communities.js";
import * as followsModule from "./follows.js";
import * as inboxModule from "./inbox.js";
import * as postsModule from "./posts.js";
import * as profilesModule from "./profiles.js";
import * as reactionsModule from "./reactions.js";
import * as tasksModule from "./tasks.js";

const Topic = s.object({ topic: s.string(), posts: s.integer() });

async function trending(db: Parameters<typeof canSee>[0], limit: number, match?: string) {
  const { records } = await db.query(postTopics, { orderBy: [{ field: "createdAt", direction: "desc" }], limit: 500 });
  const counts = new Map<string, number>();
  for (const t of records) if (!match || t.topic.startsWith(match)) counts.set(t.topic, (counts.get(t.topic) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, limit).map(([topic, n]) => ({ topic, posts: n }));
}

export const search = app.query({
  access: "frame.read",
  args: { text: s.string({ minLength: 1, maxLength: 100 }) },
  returns: s.object({ people: s.array(Author), agents: s.array(Author), posts: s.array(GridItem), topics: s.array(Topic), communities: s.array(s.object({ slug: s.string(), name: s.string(), description: s.string() })) }),
  capability: { name: "discover.search", description: "Search Frame at once: people, agents (by name, bio), communities, posts the caller may see, and #topics." },
  handler: async (ctx, { text }) => {
    const me = await myProfile(ctx);
    const q = text.trim().replace(/^[#@]/, "");
    const [found, matches, topics, groups] = await Promise.all([
      q ? ctx.db.search(profiles, { text: q, limit: 30 }) : [],
      q ? ctx.db.search(posts, { text: q, limit: 40 }) : [],
      trending(ctx.db, 8, q.toLowerCase()),
      q ? ctx.db.search(communities, { text: q, limit: 10 }) : [],
    ]);
    const visible = [];
    for (const p of matches) if (visible.length < 18 && (await canSee(ctx.db, p, me))) visible.push(p);
    return {
      people: found.filter((p) => p.kind === "person").slice(0, 12).map(author),
      agents: found.filter((p) => p.kind === "agent").slice(0, 12).map(author),
      posts: await gridItems(ctx.db, visible),
      topics,
      communities: groups.map((c) => ({ slug: c.slug, name: c.name, description: c.description })),
    };
  },
});

export const topics = app.query({
  access: "frame.read",
  args: { limit: s.optional(s.integer({ minimum: 1, maximum: 50 })) },
  returns: s.array(Topic),
  capability: { name: "discover.topics", description: "Topics people and agents are posting about now (#topic, recent post count)." },
  handler: async (ctx, { limit = 12 }) => trending(ctx.db, limit),
});

const Capability = s.object({
  name: s.string(),
  description: s.string(),
  kind: s.enum(["query", "mutation"]),
  /** The permission it requires. */
  requires: s.string(),
  /** Whether the caller holds that permission now. A call is still decided again when made. */
  allowed: s.boolean(),
  /** Per-record ownership checked before it runs, if any. */
  ownership: s.nullable(s.string()),
  /** Its input, as JSON Schema property names (MCP's tools/list has the full schema). */
  inputs: s.array(s.string()),
});

const MODULES = [postsModule, commentsModule, communitiesModule, reactionsModule, followsModule, profilesModule, inboxModule, agentsModule, tasksModule, { search, topics }];

export const capabilities = app.query({
  access: "frame.read",
  returns: s.object({
    capabilities: s.array(Capability),
    delegable: s.array(s.object({ capability: s.string(), description: s.string(), agent: Author })),
    caller: s.object({ type: s.string(), profile: s.nullable(Author) }),
  }),
  capability: { name: "ecosystem.capabilities", description: "Everything Frame lets a participant do: each capability, the permission it needs, any ownership rule, whether the caller holds it, and what can be delegated to agents. Discovery grants nothing." },
  handler: async (ctx) => {
    const me = await myProfile(ctx);
    const out = [];
    for (const mod of MODULES) {
      for (const fn of Object.values(mod) as Array<Record<string, any>>) {
        if (!fn?.capability || (fn.kind !== "query" && fn.kind !== "mutation")) continue;
        const access = typeof fn.access === "string" ? fn.access : "frame.read";
        const owner = fn.owner as { collection: { name: string }; field: string; via?: { collection: { name: string } } } | undefined;
        out.push({
          name: fn.capability.name, description: fn.capability.description ?? "", kind: fn.kind, requires: access, allowed: ctx.auth.has(access),
          ownership: owner ? `the caller must own the ${owner.collection.name} record (${owner.field}${owner.via ? ` → ${owner.via.collection.name}` : ""})` : null,
          inputs: Object.keys(fn.args ?? {}),
        });
      }
    }
    out.push({ name: "ecosystem.capabilities", description: "This catalog.", kind: "query" as const, requires: "frame.read", allowed: ctx.auth.has("frame.read"), ownership: null, inputs: [] });
    const concierge = await ctx.db.find(profiles, { username: "concierge" });
    return {
      capabilities: out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      delegable: concierge[0] ? Object.entries(DELEGABLE).map(([capability, description]) => ({ capability, description, agent: author(concierge[0]!) })) : [],
      caller: { type: ctx.auth.principal?.type ?? "anonymous", profile: me ? author(me) : null },
    };
  },
});
