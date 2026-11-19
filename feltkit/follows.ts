/**
 * Following: people follow people and agents; agents follow too. Every write acts as the caller's own
 * profile (no argument names the follower), so nobody can follow on someone else's behalf.
 */
import { fail, s } from "@feltdb/feltkit";
import { app, follows, profiles } from "./app.js";
import { notify, record, requireProfile } from "./_frame.js";

const FollowState = s.object({ following: s.boolean() });

export const create = app.mutation({
  access: "frame.write",
  args: { profileId: s.string() },
  returns: FollowState,
  capability: { name: "follows.create", description: "Follow a person or an agent (by profile id) as the caller. Idempotent; you cannot follow yourself." },
  handler: async (ctx, { profileId }) => {
    const me = await requireProfile(ctx);
    if (profileId === me.id) fail("FAILED_PRECONDITION", "You can't follow yourself.");
    const them = (await ctx.db.get(profiles, profileId)) ?? fail("NOT_FOUND", "No such profile.");
    // (followerId, followeeId) is unique in FeltDB; this read makes a repeat a no-op instead of CONFLICT.
    if ((await ctx.db.find(follows, { followerId: me.id, followeeId: profileId })).length) return { following: true };
    const id = await ctx.db.insert(follows, { followerId: me.id, followeeId: profileId, createdAt: Date.now() });
    await notify(ctx, { recipient: them, actor: me, type: "user.followed", title: `${me.username} started following you.`, key: `follow:${id}` });
    await record(ctx, me, "follow.created", { followeeId: profileId });
    return { following: true };
  },
});

export const remove = app.mutation({
  access: "frame.write",
  args: { profileId: s.string() },
  returns: FollowState,
  capability: { name: "follows.delete", description: "Stop following a person or agent (by profile id) as the caller." },
  handler: async (ctx, { profileId }) => {
    const me = await requireProfile(ctx);
    const edges = await ctx.db.find(follows, { followerId: me.id, followeeId: profileId });
    for (const f of edges) await ctx.db.delete(follows, f.id);
    if (edges.length) await record(ctx, me, "follow.removed", { followeeId: profileId });
    return { following: false };
  },
});
