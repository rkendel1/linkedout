/**
 * LinkedOut demo network, through the public HTTP contract only (the same calls the app makes):
 * a LinkedIn-format connection export and the owner's own context file (scripts/demo-network/,
 * fictional people and companies), one job posting they saw, their goal, two ties they know of, one
 * conversation, a link to a Frame profile, and a sync of their Frame follows. Re-running changes nothing.
 *
 *   node scripts/seed-network.ts [http://localhost:3000]            # as demo@frame.example (npm run seed first)
 *   node scripts/seed-network.ts [url] --dev ada                     # as a development user
 */
import { readFileSync } from "node:fs";
import { createClient } from "@feltdb/feltkit/client";
import { api } from "../feltkit/_generated/api.ts";

const args = process.argv.slice(2);
const url = args.find((a) => a.startsWith("http")) ?? process.env.FRAME_URL ?? "http://localhost:3000";
const dev = args.includes("--dev") ? args[args.indexOf("--dev") + 1] : null;
const file = (name: string) => readFileSync(new URL(`./demo-network/${name}`, import.meta.url), "utf8");

let token: string | null = null;
const client = createClient({ url, session: "bearer", tokens: { get: () => token, set: (t) => void (token = t) }, context: false });
if (dev) await client.signInAsDevUser(dev);
else await client.signIn({ email: "demo@frame.example", password: "frame-demo-password" });

const log = (step: string, v: unknown) => console.log(`[network] ${step}:`, typeof v === "string" ? v : JSON.stringify(v));

for (const name of ["Connections.csv", "context.csv"]) {
  const r = await client.mutation(api.network.importConnections, { fileName: name, csv: file(name) });
  log(`import ${name}`, r.replayed ? "already imported" : { created: r.created, matched: r.matched, skipped: r.skipped.length });
}
log("hiring signal", await client.mutation(api.intel.recordHiring, { organization: "Lumen AI", role: "Director of Product, AI Platform", sourceUri: "https://jobs.example.com/lumen-ai/director-product" }));
log("goal", (await client.mutation(api.intel.setGoal, { text: "My next AI product leadership role" })).understood);

const all = (await client.query(api.network.search, { relationship: "any", limit: 200 })).people;
const id = (name: string) => all.find((p) => p.person.displayName === name)?.person.id;
const wen = (await client.mutation(api.network.addPerson, { displayName: "Wen Li", organization: "Atlas AI", title: "VP Product", relationship: "none" })).personId;
await client.mutation(api.network.addTie, { personId: id("Liam O'Connor")!, otherId: wen, context: "worked together at Vector Forge" });
await client.mutation(api.network.addTie, { personId: id("Isabel Duarte")!, otherId: id("Daniel Reyes")!, context: "she coaches his leadership team" });
log("ties", "Liam ↔ Wen Li (Atlas AI), Isabel ↔ Daniel");

const isabel = await client.query(api.network.person, { personId: id("Isabel Duarte")! });
if (!isabel.interactions.length) {
  await client.mutation(api.network.recordInteraction, { personId: id("Isabel Duarte")!, kind: "meeting", occurredAt: Date.now() - 40 * 86_400_000, note: "Coffee: talked about my next step" });
  await client.mutation(api.network.setRelationship, { personId: id("Isabel Duarte")!, closeness: 5, context: "my executive coach for three years" });
}

// Frame's own demo has a @maya.okafor: if it's there, she's the Maya in this network.
const maya = await client.query(api.network.person, { personId: id("Maya Okafor")! });
if (!maya.frameProfile) {
  try {
    log("link Maya to Frame", (await client.mutation(api.network.linkProfile, { personId: maya.person.id, username: "maya.okafor" })).profile.username);
  } catch (e) {
    log("link Maya to Frame", `skipped (${(e as Error).message})`);
  }
}
if (await client.query(api.profiles.me, {})) log("sync from Frame", await client.mutation(api.intel.syncFrame, {}));
console.log("[network] done. Open /network and ask: “Find five people in my network who could help me find my next AI product leadership opportunity”.");
