/**
 * Seeds a running Frame with demo people, photos, follows, reactions, conversations, and the agents
 * at work: Scout answering mentions, Concierge thanking commenters for the demo visitor.
 *
 *   npm run seed                       # against http://localhost:3000
 *   npm run seed -- https://frame.example.com
 *
 * It uses only Frame's public contract, as a browser would: built-in account sign-up, Frame's
 * functions, and single-use upload links. Nothing is written around the authorization rules, so
 * it works the same against development or a deployed instance. Re-running it is a no-op.
 *
 * Photos are fetched at seed time from Unsplash's CDN (Unsplash License: free to use, no
 * attribution required); each post records its source URL in docs/SEED-PHOTOS.md. They are cached
 * in .feltkit/seed-cache/ and never committed. Offline, pass --generated for plain gradient images.
 */
import { createClient, type TokenStore } from "@feltdb/feltkit/client";
import { api } from "../feltkit/_generated/api.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.argv.slice(2).find((a) => a.startsWith("http")) ?? process.env.FRAME_URL ?? "http://localhost:3000";
const GENERATED = process.argv.includes("--generated");
export const PASSWORD = "frame-demo-password";
const CACHE = join(process.cwd(), ".feltkit", "seed-cache");

type Shot = [unsplashId: string | string[], caption: string, shape?: "square" | "portrait" | "landscape"];
type Persona = { username: string; name: string; bio: string; avatar: string; interests: string[]; posts: Shot[] };

export const PEOPLE: Persona[] = [
  { username: "maya.okafor", name: "Maya Okafor", bio: "Chasing first light. Mountains, lakes, long walks.", avatar: "1494790108377-be9c29b29330", interests: ["landscape", "mountains", "film"], posts: [
    ["1506744038136-46273834b3fb", "Valley at dawn. The river was so still it looked painted. #landscape #mountains", "portrait"],
    ["1493246507139-91e8fad9978e", "Glacier water does this colour all on its own. #landscape", "landscape"],
    ["1519681393784-d120267933ba", "Stayed up for this one. Worth every cold minute. #mountains #night", "square"],
    ["1469474968028-56623f02e42e", "Fog rolled in and the ridge disappeared for an hour."],
    ["1418065460487-3e41a6c84dc5", "Pines in the mist", "square"],
  ] },
  { username: "theo.marchetti", name: "Theo Marchetti", bio: "Cook, eater, dishwasher. Recipes in my head, never written down.", avatar: "1500648767791-00dcc994a43e", interests: ["food", "cooking"], posts: [
    ["1565299624946-b28f40a0ae38", "Friday pizza. Dough proofed 48 hours, no regrets. #food", "square"],
    ["1484723091739-30a097e8f929", "Brioche french toast, blueberries, a little too much butter. #food #brunch"],
    ["1467003909585-2f8a72700288", "Seared salmon on a bed of whatever was in the fridge."],
    ["1512621776951-a57141f2eefd", "Lunch that actually keeps you going till six.", "square"],
  ] },
  { username: "june.park", name: "June Park", bio: "Coffee notes from wherever I am. Oat milk apologist.", avatar: "1534528741775-53994a69daeb", interests: ["coffee", "cafes"], posts: [
    ["1495474472287-4d71bcdd2085", "Two flat whites and a long catch-up. #coffee", "square"],
    ["1509042239860-f550ce710b93", "This place has more plants than chairs and I love it. #cafes #plants"],
    ["1555396273-367ea4eb4db5", "New favourite spot. The light at 4pm is unreal.", "landscape"],
    ["1517248135467-4c7edcad34c4", "Before opening. Quiet is underrated."],
  ] },
  { username: "sol.reyes", name: "Sol Reyes", bio: "Carry-on only. 31 countries and counting.", avatar: "1507003211169-0a1dd7228f2d", interests: ["travel", "landscape"], posts: [
    ["1476514525535-07fb3b4ae5f1", "Rowed out before breakfast. Nobody else on the lake."],
    ["1501785888041-af3ef285b470", "Turquoise, no filter. I checked twice. #travel #landscape", "landscape"],
    ["1500530855697-b586d89ba3ee", "The road goes on for another 200 km like this."],
    ["1500835556837-99ac94a94552", "Window seat, always. #travel", "square"],
    [["1529156069898-49953e39b3ac", "1507525428034-b723cf961d3e", "1500530855697-b586d89ba3ee"], "Last evenings on the coast. Swipe → #travel #landscape", "landscape"],
  ] },
  { username: "nadia.haddad", name: "Nadia Haddad", bio: "Small apartment, big plants. Slowly furnishing.", avatar: "1544005313-94ddf0286df2", interests: ["plants", "interiors"], posts: [
    ["1502672260266-1c1ef2d93688", "Living room, finally done. Took a year of flea markets. #interiors"],
    ["1485955900006-10f4d324d411", "The succulent survived the winter. A first.", "square"],
    ["1501004318641-b39e6451bec6", "Propagation update: it has roots! #plants", "portrait"],
    ["1490750967868-88aa4486c946", "Spring at the market. Bought too many again.", "square"],
  ] },
  { username: "kit.lawson", name: "Kit Lawson", bio: "Biscuit (beagle) and Moss (cat) run this account. I just hold the camera.", avatar: "1539571696357-5a69c17a67c6", interests: ["pets"], posts: [
    ["1543466835-00a7907e9de1", "Biscuit heard the word walk. #pets", "portrait"],
    ["1518791841217-8f162f1e1131", "Moss, unimpressed as always. #pets", "square"],
    ["1517849845537-4d257902454a", "Met this gentleman at the park today.", "square"],
    ["1514888286974-6c03e2ca1dba", "He thinks the table is his.", "portrait"],
  ] },
  { username: "ravi.menon", name: "Ravi Menon", bio: "Streets, skylines, and the walk in between.", avatar: "1506794778202-cad84cf45f1d", interests: ["city", "street", "film"], posts: [
    ["1477959858617-67f85cf4f1df", "From 60 floors up the city looks almost calm. #city", "square"],
    ["1480714378408-67cf0d13bc1b", "Golden hour hits different between the towers."],
    ["1449824913935-59a10b8d2000", "Sunday morning, empty avenue. #street #city", "portrait"],
    ["1514565131-fce0801e5785", "Blue hour over the water.", "landscape"],
  ] },
  { username: "elle.brooks", name: "Elle Brooks", bio: "Styling and film. Shooting on whatever still works.", avatar: "1517841905240-472988babdf9", interests: ["film", "fashion"], posts: [
    ["1515886657613-9f3515b0c78f", "Head-to-toe yellow. Shoot for a friend's label.", "portrait"],
    ["1452587925148-ce544e77e70d", "Prints came back. Three rolls, nine keepers. #film", "square"],
    ["1516035069371-29a1b244cc32", "Kit for tomorrow. #film", "square"],
    ["1483985988355-763728e1935b", "Errands, but make it a moodboard."],
  ] },
];

/** The visitor's account: follows most people, so its feed is full on first sign-in. */
export const DEMO = { email: "demo@frame.example", username: "demo", name: "Demo Visitor", bio: "Just looking around.", interests: ["film", "travel"] };
const emailOf = (username: string) => `${username.replace(/\./g, "-")}@frame.example`;

const REPLIES = ["Agreed!", "Right?", "Same here.", "Ha, exactly.", "This thread is the best part.", "Seconded.", "Came here to say this."];
const KINDS = ["like", "like", "like", "celebrate", "wow", "insightful", "funny", "support"] as const;
const COMMENTS = [
  "This is stunning.", "Okay, I need to go here.", "The light!", "Saving this one.", "Wow, love the colours.",
  "How do you always find these spots?", "Absolutely beautiful.", "This made my morning.", "Framed. Literally.",
  "Need the recipe please.", "Goals.", "So good.", "Teach me your ways.", "That composition."
];

// Deterministic: the same people like and comment on the same posts on every fresh seed.
let state = 7;
const rand = () => ((state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const SIZES = { portrait: [1080, 1350], square: [1080, 1080], landscape: [1080, 720] } as const;

async function photo(id: string, w: number, h: number, faces = false): Promise<Uint8Array> {
  mkdirSync(CACHE, { recursive: true });
  const file = join(CACHE, `${id}-${w}x${h}.jpg`);
  if (existsSync(file)) return readFileSync(file);
  let bytes: Uint8Array;
  if (GENERATED) {
    const hue = [...id].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
    execFileSync("convert", ["-size", `${w}x${h}`, `gradient:hsl(${hue},55%,62%)-hsl(${(hue + 50) % 360},45%,28%)`, "-quality", "85", file]);
    bytes = readFileSync(file);
  } else {
    const url = `https://images.unsplash.com/photo-${id}?w=${w}&h=${h}&fit=crop${faces ? "&crop=faces" : ""}&fm=jpg&q=80`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not download ${url} (${res.status}). Offline? Run with --generated.`);
    bytes = new Uint8Array(await res.arrayBuffer());
    writeFileSync(file, bytes);
  }
  return bytes;
}

/** A signed-in Frame client for one account: signs up the first time, signs in afterwards. */
async function account(email: string, name: string) {
  let token: string | null = null;
  const tokens: TokenStore = { get: () => token, set: (t) => void (token = t) };
  const client = createClient({ url: BASE, session: "bearer", tokens, context: false });
  try {
    await client.signUp({ email, password: PASSWORD, name });
  } catch (e) {
    if ((e as { code?: string }).code !== "CONFLICT") throw e;
    await client.signIn({ email, password: PASSWORD });
  }
  return client;
}

async function main() {
  console.log(`Seeding ${BASE}${GENERATED ? " (generated images)" : ""}`);
  const clients = new Map<string, Awaited<ReturnType<typeof account>>>();
  const ids = new Map<string, string>();
  for (const p of [...PEOPLE, { ...DEMO, avatar: "", posts: [] as Shot[] }]) {
    const client = await account("email" in p ? (p as typeof DEMO).email : emailOf(p.username), p.name);
    clients.set(p.username, client);
    const existing = await client.query(api.profiles.me);
    ids.set(p.username, existing?.id ?? (await client.mutation(api.profiles.create, { username: p.username, displayName: p.name, bio: p.bio, interests: p.interests })));
    if (!existing?.avatarFileId && p.avatar) {
      const link = await client.mutation(api.profiles.avatarUploadLink);
      const file = await client.uploadFile(link, await photo(p.avatar, 320, 320, true), { name: "avatar.jpg", contentType: "image/jpeg" });
      await client.mutation(api.profiles.update, { avatarFileId: file.id });
    }
  }
  const already = (await clients.get(PEOPLE[0]!.username)!.query(api.profiles.get, { username: PEOPLE[0]!.username }))!.stats.posts > 0;
  if (already) {
    console.log("Already seeded: nothing to do.");
    return;
  }

  // Posts, round-robin across people (oldest first), so every feed is interleaved.
  const posts: Array<{ id: string; author: string }> = [];
  const longest = Math.max(...PEOPLE.map((p) => p.posts.length));
  for (let i = longest - 1; i >= 0; i--) {
    for (const p of PEOPLE) {
      const shot = p.posts[i];
      if (!shot) continue;
      const [w, h] = SIZES[shot[2] ?? "portrait"];
      const client = clients.get(p.username)!;
      const media = [];
      for (const id of [shot[0]].flat()) {
        const file = await client.uploadFile(await client.mutation(api.posts.uploadLink), await photo(id, w, h), { name: "photo.jpg", contentType: "image/jpeg" });
        media.push({ fileId: file.id, width: w, height: h });
      }
      posts.push({ id: await client.mutation(api.posts.create, { text: shot[1], media }), author: p.username });
      process.stdout.write(".");
    }
  }
  // Text posts: not every update needs a photo.
  posts.push({ id: await clients.get("ravi.menon")!.mutation(api.posts.create, { text: "Hot take: the best #street photos happen in the ten minutes after it stops raining." }), author: "ravi.menon" });
  posts.push({ id: await clients.get("elle.brooks")!.mutation(api.posts.create, { text: "Looking for a lab that still does push processing on #film. Recommendations?", visibility: "followers" }), author: "elle.brooks" });
  console.log(` ${posts.length} posts`);

  // Follows: each person follows about half the others; the demo visitor follows all but two.
  const everyone = [...PEOPLE.map((p) => p.username), DEMO.username];
  let follows = 0;
  for (const who of everyone) {
    for (const other of PEOPLE.map((p) => p.username)) {
      if (other === who) continue;
      const follow = who === DEMO.username ? !["kit.lawson", "elle.brooks"].includes(other) : rand() < 0.55;
      if (follow) (await clients.get(who)!.mutation(api.follows.create, { profileId: ids.get(other)! }), follows++);
    }
  }
  // The visitor follows Scout, so agents are in the feed from the start.
  const demo = clients.get(DEMO.username)!;
  const scout = (await demo.query(api.profiles.get, { username: "scout" }))!;
  await demo.mutation(api.follows.create, { profileId: scout.id });

  // Reactions, comments and replies from people other than the author (a post they can't see is skipped).
  let reactions = 0;
  let comments = 0;
  for (const post of posts) {
    const thread: Array<{ id: string; by: string }> = [];
    for (const who of PEOPLE.map((p) => p.username)) {
      if (who === post.author) continue;
      const client = clients.get(who)!;
      if (!(await client.query(api.posts.get, { id: post.id }))) continue;
      if (rand() < 0.6) (await client.mutation(api.reactions.set, { postId: post.id, kind: KINDS[Math.floor(rand() * KINDS.length)]! }), reactions++);
      if (rand() < 0.18) {
        const parent = thread.length && rand() < 0.4 ? thread[Math.floor(rand() * thread.length)]! : null;
        const text = parent ? REPLIES[Math.floor(rand() * REPLIES.length)]! : COMMENTS[Math.floor(rand() * COMMENTS.length)]!;
        const id = await client.mutation(api.comments.create, { postId: post.id, text, ...(parent && parent.by !== who ? { parentId: parent.id } : {}) });
        thread.push({ id, by: who });
        comments++;
        if (thread.length > 1 && rand() < 0.5) (await clients.get(post.author)!.mutation(api.reactions.set, { postId: post.id, commentId: id, kind: "like" }), reactions++);
      }
    }
  }
  // Communities: people gather around subjects; the visitor is in one, so it reaches their home feed.
  const film = await clients.get("elle.brooks")!.mutation(api.communities.create, { slug: "film-lab", name: "Film Lab", description: "Developing, scanning and printing film. Share your rolls, ask about stocks.", topics: ["film", "darkroom"] });
  const trails = await clients.get("sol.reyes")!.mutation(api.communities.create, { slug: "slow-travel", name: "Slow Travel", description: "Fewer places, longer stays. Routes, trains, small towns.", topics: ["travel", "landscape"] });
  for (const u of ["ravi.menon", "maya.okafor", DEMO.username]) await clients.get(u)!.mutation(api.communities.join, { slug: "film-lab" });
  for (const u of ["maya.okafor", "june.park", DEMO.username]) await clients.get(u)!.mutation(api.communities.join, { slug: "slow-travel" });
  await clients.get("ravi.menon")!.mutation(api.posts.create, { text: "Pushed Tri-X two stops for the night walk. Grain is part of the story. #film", communityId: film });
  await clients.get("june.park")!.mutation(api.posts.create, { text: "Night train Vienna → Venice: book the couchette, wake up to the Alps. #travel", communityId: trails });

  // People ask Scout (a resident agent) about a few posts; it answers as itself, after each commit.
  const asks = posts.filter((_, i) => i % 9 === 4).slice(0, 4);
  for (const [i, post] of asks.entries()) {
    const who = PEOPLE.map((p) => p.username).filter((u) => u !== post.author)[i % 5]!;
    if (await clients.get(who)!.query(api.posts.get, { id: post.id })) await clients.get(who)!.mutation(api.comments.create, { postId: post.id, text: "@scout anything else like this?" });
  }

  // The visitor lets Concierge thank commenters, and gets a digest.
  await demo.mutation(api.tasks.grant, { capability: "frame.react" });
  await demo.mutation(api.tasks.grant, { capability: "frame.digest" });
  await demo.mutation(api.tasks.create, { kind: "react" });
  const link = await demo.mutation(api.posts.uploadLink);
  const file = await demo.uploadFile(link, await photo("1500530855697-b586d89ba3ee", 1080, 720), { name: "photo.jpg", contentType: "image/jpeg" });
  const mine = await demo.mutation(api.posts.create, { text: "First post on Frame. Where should I go next? #travel", media: [{ fileId: file.id, width: 1080, height: 720 }] });
  await clients.get("sol.reyes")!.mutation(api.comments.create, { postId: mine, text: "Lisbon. No question." });
  await clients.get("maya.okafor")!.mutation(api.comments.create, { postId: mine, text: "The Dolomites in September! @scout" });
  await clients.get("sol.reyes")!.mutation(api.reactions.set, { postId: mine, kind: "celebrate" });
  await new Promise((r) => setTimeout(r, 1500));
  await demo.mutation(api.tasks.create, { kind: "digest" });
  console.log(`${everyone.length} people, ${follows} follows, ${reactions} reactions, ${comments} comments, ${asks.length} questions for Scout`);
  console.log(`Sign in as ${DEMO.email} / ${PASSWORD} (or any ${"<username>"}@frame.example, dots as dashes).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
