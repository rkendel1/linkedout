/**
 * Demo data for a public demo deployment (scripts/demo-server.mjs runs it once the server is up).
 * It goes through the application's own functions over HTTP, signed in as development users,
 * exactly as a person clicking the app's own "load demo data" control would. Re-running it is a no-op.
 *
 *   node --import tsx scripts/demo-seed.ts [http://127.0.0.1:3000]
 */
import { createClient } from "@feltdb/feltkit/client";
import { api } from "../feltkit/_generated/api.js";

const url = process.argv[2] ?? "http://127.0.0.1:3000";

/** A client signed in as one of the app's declared dev users (development environment only). */
async function as(devUser: string) {
  let token: string | null = null;
  const client = createClient({ url, session: "bearer", tokens: { get: () => token, set: (t) => void (token = t) }, context: false });
  await client.signInAsDevUser(devUser);
  return client;
}

/** Run one step; a refusal with one of `done` means the data is already there. */
async function step(name: string, run: () => Promise<unknown>, done: string[] = []) {
  try {
    console.log(`[demo] ${name}:`, JSON.stringify(await run()) ?? "ok");
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code && done.includes(code)) console.log(`[demo] ${name}: already done.`);
    else throw e;
  }
}

import { spawnSync } from "node:child_process";

// Frame's own demo people, photos, follows, conversations and agents (npm run seed; a no-op when present).
// DEMO_GENERATED_IMAGES=1 uses generated images instead of downloading photos from Unsplash.
const seed = spawnSync(process.execPath, ["--import", "tsx", "scripts/seed.ts", url, ...(process.env.DEMO_GENERATED_IMAGES === "1" ? ["--generated"] : [])], { stdio: "inherit" });
if (seed.status !== 0) throw new Error(`scripts/seed.ts failed (exit ${seed.status})`);

// The app signs a visitor in as Ada: give her a profile and follow everyone, so her feed is full.
const ada = await as("ada");
if (!(await ada.query(api.profiles.me, {}))) {
  await step("Ada's profile", () => ada.mutation(api.profiles.create, { username: "ada", displayName: "Ada Lovelace", bio: "Visiting the Frame demo.", interests: ["travel", "film", "landscape"] }));
}
for (const { profile } of await ada.query(api.profiles.suggested, { limit: 30 })) {
  await ada.mutation(api.follows.create, { profileId: profile.id });
}
console.log("[demo] Ada follows everyone.");
