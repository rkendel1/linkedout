/**
 * Upgrading a real Frame 1 state: Frame 1's own code (from git, commit 77a6c0b) writes profiles, a
 * photo post, a like and a comment into a FeltDB state directory; Frame 2 opens the same directory.
 * Its migration runs in the transaction that installs the new schema: the photo moves to `media`, the
 * like becomes a reaction, profiles become people, and the resident agents join.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestApp } from "@feltdb/feltkit/testing";
import { createApi } from "@feltdb/feltkit/client";
import { api } from "../feltkit/_generated/api.js";

const FRAME_1 = "77a6c0b";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);
const member = (id: string) => ({ id, type: "user" as const, roles: ["member"] });
const hasGit = (() => { try { execFileSync("git", ["cat-file", "-e", `${FRAME_1}:feltkit/app.ts`], { stdio: "ignore" }); return true; } catch { return false; } })();

test("Frame 1 state upgrades to Frame 2 without losing anything", { skip: !hasGit && "Frame 1 not in this checkout" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "frame-migration-"));
  const old = join(root, "frame1");
  const storage = { kind: "local" as const, path: join(root, "state") };
  try {
    mkdirSync(join(old, "feltkit"), { recursive: true });
    for (const f of ["app.ts", "_frame.ts", "posts.ts", "social.ts", "inbox.ts", "profiles.ts"]) {
      writeFileSync(join(old, "feltkit", f), execFileSync("git", ["show", `${FRAME_1}:feltkit/${f}`]));
    }
    writeFileSync(join(old, "package.json"), JSON.stringify({ name: "frame", version: "0.1.0", type: "module", private: true }));
    symlinkSync(join(process.cwd(), "node_modules"), join(old, "node_modules"));
    const v1: any = createApi<any>();

    const t1 = await createTestApp({ projectDir: old, storage });
    let postId: string;
    try {
      const maya = t1.as(member("maya"));
      const leo = t1.as(member("leo"));
      await maya.mutation(v1.profiles.create, { username: "maya", displayName: "Maya" });
      await leo.mutation(v1.profiles.create, { username: "leo", displayName: "Leo" });
      const link = (await maya.mutation(v1.posts.uploadLink)) as { url: string };
      const file = await t1.runtime.services.redeemUpload(link.url.split("/").pop()!, async () => JPEG, { contentType: "image/jpeg", name: "a.jpg" });
      postId = <string>await maya.mutation(v1.posts.create, { fileId: file.id, caption: "Before the upgrade #film", width: 800, height: 1000 });
      await leo.mutation(v1.social.like, { postId });
      await leo.mutation(v1.social.comment, { postId, text: "Classic." });
    } finally {
      await t1.close();
    }

    const t2 = await createTestApp({ storage });
    try {
      const leo = t2.as(member("leo"));
      const card = (await leo.query(api.posts.get, { id: postId! }))!;
      assert.equal(card.text, "Before the upgrade #film");
      assert.equal(card.visibility, "public");
      assert.deepEqual(card.topics, ["film"]);
      assert.equal(card.media.length, 1);
      assert.deepEqual([card.reactions.counts.like, card.reactions.mine], [1, "like"]);
      assert.equal(card.commentCount, 1);
      assert.equal(card.author.kind, "person");
      assert.equal((await leo.query(api.posts.byTopic, { topic: "film" })).posts.length, 1);
      assert.deepEqual((await leo.query(api.agents.directory, {})).map((a) => a.profile.username).sort(), ["concierge", "scout"]);
      // The upgraded records are live: Leo can change the migrated reaction.
      await leo.mutation(api.reactions.set, { postId: postId!, kind: "wow" });
      assert.deepEqual((await leo.query(api.posts.get, { id: postId! }))!.reactions.counts, { wow: 1 });
    } finally {
      await t2.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
