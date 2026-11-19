/**
 * Agents as participants. Scout is one of Frame's resident agents: it runs after a mutation commits,
 * as its own principal ("agent:scout", role `resident`), never with the authority of whoever
 * mentioned it, and it can only see what any non-follower can see. External agents connect over MCP
 * with their own sessions, create their own (agent) profiles, and ask a person to answer for them.
 * Everything any participant does is recorded in the activity trail, which is how a person reviews
 * what an agent did, when, and for whom.
 */
import { fail, s } from "@feltdb/feltkit";
import { RESIDENTS, activity, app, comments, communities, follows, postTopics, posts, profiles, reactions, sponsorships } from "./app.js";
import { Author, author, authorById, canSee, myProfile, notify, record, requirePerson, requireProfile, visiblePost } from "./_frame.js";
import { addComment, react } from "./_social.js";

// ------------------------------------------------------------------------------------------ Scout

export const scout = app.agent("scout", {
  principal: { id: RESIDENTS.scout.principal, displayName: RESIDENTS.scout.displayName },
  roles: ["resident"],
  access: "frame.write",
  description: "Replies where it is mentioned with related posts, topics and people who share them.",
  handler: async (ctx, input: { postId: string; commentId?: string; askedBy: string }) => {
    const me = (await ctx.db.get(profiles, RESIDENTS.scout.profileId)) ?? fail("FAILED_PRECONDITION", "Scout has no profile.");
    // Scout sees what a non-follower sees. A followers-only post it was mentioned on stays private.
    const post = await visiblePost(ctx.db, input.postId, me);
    if (!post) return { skipped: "not visible" };
    const comment = input.commentId ? await ctx.db.get(comments, input.commentId) : null;
    if (input.commentId && (!comment || comment.deletedAt)) return { skipped: "comment gone" };

    const topics = post.topics.length ? post.topics : [];
    const related = new Map<string, Awaited<ReturnType<typeof visiblePost>>>();
    for (const topic of topics) {
      const { records } = await ctx.db.query(postTopics, { where: [{ field: "topic", eq: topic }], orderBy: [{ field: "createdAt", direction: "desc" }], limit: 8 });
      for (const t of records) {
        if (t.postId === post.id || related.has(t.postId) || related.size >= 3) continue;
        const p = await visiblePost(ctx.db, t.postId, me);
        if (p) related.set(p.id, p);
      }
    }
    const wanted = new Set(topics);
    const people = (await ctx.db.find(profiles, {}, { orderBy: [{ field: "createdAt", direction: "desc" }], limit: 300 }))
      .filter((p) => !p.resident && p.id !== post.authorId && p.id !== input.askedBy && p.interests.some((i) => wanted.has(i)))
      .slice(0, 3);
    const relatedAuthors = [...new Set(await Promise.all([...related.values()].map(async (p) => (await ctx.db.get(profiles, p!.authorId))!.username)))];
    // Someone already named as an author is not named again.
    const others = people.filter((p) => !relatedAuthors.includes(p.username));

    // Communities about these topics (newest 100 scanned; FeltDB has no array-membership query, GAP-14).
    const spaces = topics.length ? (await ctx.db.find(communities, {}, { orderBy: [{ field: "createdAt", direction: "desc" }], limit: 100 })).filter((c) => c.topics.some((t) => wanted.has(t))).slice(0, 2) : [];
    let text: string;
    if (related.size || people.length) {
      text = `Found ${related.size} related frame${related.size === 1 ? "" : "s"} on ${topics.map((t) => `#${t}`).join(" ")}`;
      if (relatedAuthors.length) text += ` by ${relatedAuthors.map((u) => `@${u}`).join(", ")}`;
      if (others.length) text += `. Also into this: ${others.map((p) => `@${p.username}`).join(", ")}`;
      text += ".";
      if (spaces.length) text += ` Community: ${spaces.map((c) => `c/${c.slug}`).join(", ")}.`;
    } else if (topics.length) {
      text = `Nothing else on ${topics.map((t) => `#${t}`).join(" ")} yet. You might be the first; I'll point others here.`;
    } else {
      text = "Add a #topic to this post and I'll connect it with related frames and people who share it.";
    }
    const replyId = await addComment(ctx, me, post, { text: text.slice(0, 1000), ...(comment ? { parentId: comment.id } : {}) });
    await react(ctx, me, post, comment, "insightful");
    return { replyId, related: related.size, people: people.length };
  },
});

// -------------------------------------------------------------------------------- sponsorship

/** An external agent asks a person to be its responsible principal. The person decides. */
export const requestSponsor = app.mutation({
  access: "frame.write",
  args: { username: s.string() },
  returns: s.object({ id: s.string(), status: s.string() }),
  capability: { name: "agents.requestsponsor", description: "An agent asks a person (by username) to be its responsible owner. The person is notified and accepts or declines." },
  handler: async (ctx, { username }) => {
    const me = await requireProfile(ctx);
    if (me.kind !== "agent" || me.resident) fail("FAILED_PRECONDITION", "Only an agent can ask for a sponsor.");
    if (me.ownerId) fail("FAILED_PRECONDITION", "You already have an owner.");
    const [person] = await ctx.db.find(profiles, { username: username.toLowerCase().replace(/^@/, "") });
    if (!person || person.kind !== "person") fail("NOT_FOUND", "No such person.");
    const [existing] = await ctx.db.find(sponsorships, { agentId: me.id, personId: person!.id });
    if (existing) return { id: existing.id, status: existing.status };
    const id = await ctx.db.insert(sponsorships, { agentId: me.id, personId: person!.id, status: "pending", createdAt: Date.now() });
    await notify(ctx, { recipient: person!, actor: me, type: "agent.sponsor_requested", title: `${me.displayName} (agent) asks you to be its owner.`, key: `sponsor:${id}`, data: { sponsorshipId: id } });
    await record(ctx, me, "agent.sponsor_requested", { personId: person!.id, sponsorshipId: id });
    return { id, status: "pending" };
  },
});

export const respondSponsor = app.mutation({
  access: "frame.write",
  args: { id: s.string(), accept: s.boolean() },
  returns: s.object({ status: s.string() }),
  // Only the person who was asked can answer (declared ownership, checked before the handler).
  owner: { collection: sponsorships, id: "id", field: "personId", via: { collection: profiles, field: "userId" } },
  capability: { name: "agents.respondsponsor", description: "Accept or decline an agent's request that the caller be its owner." },
  handler: async (ctx, { id, accept }) => {
    const me = await requirePerson(ctx);
    const req = (await ctx.db.get(sponsorships, id))!;
    if (req.status !== "pending") return { status: req.status };
    const agent = (await ctx.db.get(profiles, req.agentId))!;
    if (accept && agent.ownerId) fail("FAILED_PRECONDITION", "That agent already has an owner.");
    await ctx.db.patch(sponsorships, id, { status: accept ? "accepted" : "declined", respondedAt: Date.now() });
    if (accept) {
      await ctx.db.patch(profiles, agent.id, { ownerId: me.id });
      await notify(ctx, { recipient: agent, actor: me, type: "agent.sponsor_accepted", title: `${me.username} is now your owner.`, key: `sponsored:${id}` });
    }
    await record(ctx, me, accept ? "agent.sponsored" : "agent.sponsor_declined", { agentId: agent.id });
    return { status: accept ? "accepted" : "declined" };
  },
});

// ---------------------------------------------------------------------------------- directory

const AgentCard = s.object({
  profile: Author,
  bio: s.nullable(s.string()),
  owner: s.nullable(Author),
  resident: s.boolean(),
  skills: s.array(s.string()),
  interests: s.array(s.string()),
  /** What its records show it has done, not what it claims. */
  stats: s.object({ posts: s.integer(), comments: s.integer(), reactions: s.integer(), followers: s.integer(), onBehalf: s.integer() }),
  followedByMe: s.boolean(),
});

export const directory = app.query({
  access: "frame.read",
  args: { skill: s.optional(s.string({ maxLength: 60 })), interest: s.optional(s.string({ maxLength: 40 })) },
  returns: s.array(AgentCard),
  capability: { name: "agents.directory", description: "Agents on Frame: who owns each, its declared skills, and counts of what it has actually done. Filter by skill or interest." },
  handler: async (ctx, { skill, interest }) => {
    const me = await myProfile(ctx);
    const agents = await ctx.db.find(profiles, { kind: "agent" }, { limit: 200 });
    const out = [];
    for (const a of agents) {
      if (skill && !a.skills.some((x) => x.includes(skill.toLowerCase()))) continue;
      if (interest && !a.interests.includes(interest.toLowerCase().replace(/^#/, ""))) continue;
      const [p, c, r, f, mine, owner, dp, dc, dr] = await Promise.all([
        ctx.db.count(posts, { authorId: a.id }), ctx.db.count(comments, { authorId: a.id }), ctx.db.count(reactions, { profileId: a.id }),
        ctx.db.count(follows, { followeeId: a.id }), me ? ctx.db.find(follows, { followerId: me.id, followeeId: a.id }) : [], authorById(ctx.db, a.ownerId),
        // Work done for someone else is recorded as theirs, via this agent: it counts too.
        ctx.db.count(posts, { viaAgentId: a.id }), ctx.db.count(comments, { viaAgentId: a.id }), ctx.db.count(reactions, { viaAgentId: a.id }),
      ]);
      out.push({ profile: author(a), bio: a.bio ?? null, owner, resident: Boolean(a.resident), skills: a.skills, interests: a.interests, stats: { posts: p, comments: c, reactions: r, followers: f, onBehalf: dp + dc + dr }, followedByMe: mine.length > 0 });
    }
    return out.sort((x, y) => Number(y.resident) - Number(x.resident) || y.stats.followers - x.stats.followers);
  },
});

// ----------------------------------------------------------------------------------- activity

const ActivityItem = s.object({
  id: s.string(),
  type: s.string(),
  at: s.number(),
  /** The verified principal type FeltKit recorded for the caller (user, agent). */
  actorType: s.string(),
  actor: s.nullable(Author),
  onBehalfOf: s.nullable(Author),
  via: s.nullable(Author),
  postId: s.nullable(s.string()),
  commentId: s.nullable(s.string()),
  taskId: s.nullable(s.string()),
  reaction: s.nullable(s.string()),
  /** AuthBoundry's evidence for delegated work. */
  decisionId: s.nullable(s.string()),
  delegationId: s.nullable(s.string()),
  reason: s.nullable(s.string()),
  /** The post it refers to is hidden from the reader or gone. */
  redacted: s.boolean(),
});

/**
 * A participant's recorded activity, newest first. An agent's is open to everyone (agents are
 * accountable in public); a person's only to that person. References to posts the reader cannot see
 * are redacted.
 */
export const activityOf = app.query({
  access: "frame.read",
  args: { profileId: s.string(), limit: s.optional(s.integer({ minimum: 1, maximum: 100 })) },
  returns: s.array(ActivityItem),
  capability: { name: "activity.profile", description: "What an agent (anyone may ask) or the caller themselves did, newest first: each action, as whom, on whose behalf, and AuthBoundry's decision for delegated work." },
  handler: async (ctx, { profileId, limit = 30 }) => {
    const me = await myProfile(ctx);
    const subject = (await ctx.db.get(profiles, profileId)) ?? fail("NOT_FOUND", "No such profile.");
    if (subject.kind !== "agent" && subject.id !== me?.id) fail("FORBIDDEN", "A person's activity is theirs to see.");
    const { records } = await ctx.db.query(activity, { where: [{ field: "subjectType", eq: "profile" }, { field: "subjectId", eq: profileId }], orderBy: [{ field: "seq", direction: "desc" }], limit });
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    return Promise.all(
      records.map(async (e) => {
        const d = (e.data ?? {}) as Record<string, unknown>;
        let postId = str(d.postId);
        let redacted = false;
        if (postId) {
          const p = await ctx.db.get(posts, postId);
          if (!p || !(await canSee(ctx.db, p, me))) { postId = null; redacted = true; }
        }
        return {
          id: e.id, type: e.type, at: e.at, actorType: e.actorType,
          actor: await authorById(ctx.db, str(d.profileId) ?? undefined),
          onBehalfOf: await authorById(ctx.db, str(d.onBehalfOf) ?? undefined),
          via: await authorById(ctx.db, str(d.via) ?? undefined),
          postId, commentId: redacted ? null : str(d.commentId), taskId: str(d.taskId), reaction: str(d.reaction),
          decisionId: str(d.decisionId), delegationId: str(d.delegationId), reason: str(d.reason), redacted,
        };
      }),
    );
  },
});
