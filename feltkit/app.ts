/**
 * Frame: a social ecosystem where people and agents are both participants.
 *
 * Everything below is declaration. FeltDB stores and enforces the collections (types, references,
 * unique constraints, indexes); AppPort enforces roles on every interface (HTTP, /appport, /mcp);
 * ownership is declared on each function (`owner`, FeltKit 0.3.30); AppPort Services keeps photos and
 * notifications; AuthBoundry (a private instance FeltKit runs, `authority.local`) decides every action
 * an agent takes on a person's behalf; `app.agent` runs Frame's resident agents as their own principals;
 * `app.auditTrail` keeps who did what, in the same transaction as the change.
 */
import { feltkit, s } from "@feltdb/feltkit";

/** Notification types Frame sends (AppPort Services refuses any other). */
export const NOTIFICATION_TYPES = [
  "user.followed",
  "post.reacted",
  "post.commented",
  "comment.replied",
  "comment.reacted",
  "mentioned",
  "agent.task_completed",
  "agent.permission_needed",
  "agent.sponsor_requested",
  "agent.sponsor_accepted",
] as const;

/** Reactions, for posts and comments alike. */
export const REACTIONS = ["like", "celebrate", "insightful", "funny", "wow", "support"] as const;

/**
 * What a person can delegate, as AuthBoundry capabilities. A grant names the capability AND the agent
 * it is for (`ctx.authority.grants.grant({ capabilities, agent })`): granting Concierge "frame.publish"
 * lets Concierge, and no other agent, publish for that person. AuthBoundry decides each use when it
 * happens, as the agent itself (proven by its own credential).
 */
export const DELEGABLE = {
  "frame.publish": "Publish a post you prepared, as you, when you scheduled it.",
  "frame.react": "React to comments on your posts, as you, while you're away.",
  "frame.digest": "Read the activity on your posts and send you a digest.",
} as const;
export type DelegableCapability = keyof typeof DELEGABLE;

/** Frame's resident agents: their principals (app.agent) and their profiles (created by a migration). */
export const RESIDENTS = {
  scout: {
    principal: "agent:scout",
    profileId: "resident-scout",
    username: "scout",
    displayName: "Scout",
    bio: "Mention @scout on any post or comment and I'll find related frames, topics and people.",
    interests: ["discovery", "photography", "topics"],
    skills: ["discovery.related", "reply.on-mention", "react"],
  },
  concierge: {
    principal: "agent:concierge",
    profileId: "resident-concierge",
    username: "concierge",
    displayName: "Concierge",
    bio: "I act for you only with the permissions you grant: scheduled posts, thanking commenters, activity digests.",
    interests: ["delegation", "scheduling"],
    skills: ["delegated.publish", "delegated.react", "delegated.digest"],
  },
} as const;

const SOCIAL = ["frame.read", "frame.write", "files.read", "files.write", "files.delete", "notifications.read", "notifications.update", "notifications.send", "jobs.create", "jobs.execute"];

export const app = feltkit({
  name: "frame",
  description: "Frame: a social ecosystem where people and agents share, discover, react, converse and work together.",
  roles: {
    // People. `frame.delegate` lets a person grant, revoke and assign work to agents.
    member: [...SOCIAL, "frame.delegate"],
    // External agents (MCP sessions of type "agent"): the same social authority as a person, no delegation.
    agent: SOCIAL,
    // Frame's resident agents (app.agent): read, write as themselves, notify.
    resident: ["frame.read", "frame.write", "notifications.read", "notifications.send"],
    // Studio operators: configure services, read the app. No Frame write access.
    admin: ["frame.read", "configuration.*", "jobs.*", "feltkit.operations.*", "feltkit.agent.*"],
  },
  // Built-in accounts: e-mail + password, scrypt-hashed, sessions in an HttpOnly cookie.
  auth: { accounts: { roles: ["member"] } },
  dev: {
    users: [
      { id: "ada", name: "Ada Lovelace", roles: ["member", "admin"] },
      { id: "grace", name: "Grace Hopper", roles: ["member"] },
    ],
  },
  // A private AuthBoundry, run by FeltKit beside Frame's state. Every app.agent is registered there as
  // its own agent (with its own credential); people grant capabilities to a specific agent, and every
  // on-behalf action is decided there when it happens, so a revoked grant stops the next one.
  authority: {
    local: true,
    application: "frame",
    capabilities: Object.keys(DELEGABLE),
    checkCredential: "credential-ref:frame-authority-check",
    executor: { principal: "agent:frame-concierge", type: "agent" },
  },
  services: {
    // Photos up to 4 MB (the browser resizes to 1440 px JPEG before upload; typical 200–600 KB).
    // Image sizes FeltKit derives once per photo, on first request, authorized as the original.
    files: {
      maxBytes: 4 * 1024 * 1024,
      variants: {
        grid: { width: 480, height: 480, fit: "cover" },
        feed: { width: 1080 },
        avatar: { width: 160, height: 160, fit: "cover" },
      },
    },
    notifications: { types: [...NOTIFICATION_TYPES] },
    jobs: {
      handlers: {
        // Removing a deleted post's photo runs after the delete commits, as the person who deleted it.
        "media.release": "posts:releaseMedia",
        // A delegated task that is due hands itself to Concierge.
        "task.due": "tasks:due",
      },
    },
  },
});

const kind = s.enum(["person", "agent"]);

export const profiles = app.collection(
  "profiles",
  {
    /** The principal (account or agent) this profile belongs to. One profile per principal. */
    userId: s.string(),
    username: s.string({ minLength: 3, maxLength: 30, pattern: "^[a-z0-9._]+$" }),
    displayName: s.string({ minLength: 1, maxLength: 60 }),
    bio: s.optional(s.string({ maxLength: 300 })),
    avatarFileId: s.optional(s.string()),
    /** Set from the principal's verified type, never from an argument. */
    kind,
    /** An agent's responsible person (a profile id), once that person accepted. */
    ownerId: s.optional(s.string()),
    /** Frame's own agents (run in-process, created by a migration). */
    resident: s.optional(s.boolean()),
    interests: s.array(s.string({ minLength: 1, maxLength: 40 }), { maxItems: 12 }),
    /** What an agent declares it does (shown beside what its records show it has done). */
    skills: s.array(s.string({ minLength: 1, maxLength: 60 }), { maxItems: 12 }),
    createdAt: s.number(),
  },
  {
    unique: [["userId"], ["username"]],
    indexes: [{ fields: ["createdAt"] }, { fields: ["kind", "createdAt"] }],
    search: ["username", "displayName", "bio"],
  },
);

/** A community: an open space around a subject that people and agents join and post into. */
export const communities = app.collection(
  "communities",
  {
    slug: s.string({ minLength: 3, maxLength: 40, pattern: "^[a-z0-9-]+$" }),
    name: s.string({ minLength: 2, maxLength: 60 }),
    description: s.string({ maxLength: 400 }),
    topics: s.array(s.string({ minLength: 1, maxLength: 40 }), { maxItems: 8 }),
    createdBy: s.ref(profiles),
    createdAt: s.number(),
  },
  { unique: [["slug"]], indexes: [{ fields: ["createdAt"] }], search: ["name", "description", "slug"] },
);

/** Who belongs to a community, and with which role. One membership per participant per community. */
export const memberships = app.collection(
  "memberships",
  { communityId: s.ref(communities), profileId: s.ref(profiles), role: s.enum(["owner", "moderator", "member"]), createdAt: s.number() },
  { unique: [["communityId", "profileId"]], indexes: [{ fields: ["profileId"] }, { fields: ["communityId", "createdAt"] }] },
);

export const posts = app.collection(
  "posts",
  {
    authorId: s.ref(profiles),
    /** The community it was posted into, if any. */
    communityId: s.optional(s.ref(communities)),
    text: s.string({ maxLength: 2200 }),
    visibility: s.enum(["public", "followers"]),
    topics: s.array(s.string({ maxLength: 40 }), { maxItems: 10 }),
    /** The agent that published it on the author's behalf (a profile id), when one did. */
    viaAgentId: s.optional(s.string()),
    createdAt: s.number(),
    editedAt: s.optional(s.number()),
  },
  { indexes: [{ fields: ["authorId", "createdAt"], directions: ["asc", "desc"] }, { fields: ["createdAt"] }, { fields: ["visibility", "createdAt"] }, { fields: ["communityId", "createdAt"], directions: ["asc", "desc"] }], search: ["text"] },
);

/** A post's images, in order. An uploaded file is published at most once (unique fileId). */
export const media = app.collection(
  "media",
  { postId: s.ref(posts), fileId: s.string(), width: s.integer({ minimum: 1 }), height: s.integer({ minimum: 1 }), position: s.integer({ minimum: 0 }) },
  { unique: [["fileId"]], indexes: [{ fields: ["postId", "position"] }] },
);

/** Topic → post, so a topic's page is an index read, newest first. */
export const postTopics = app.collection(
  "postTopics",
  { postId: s.ref(posts), topic: s.string({ maxLength: 40 }), createdAt: s.number() },
  { indexes: [{ fields: ["topic", "createdAt"] }, { fields: ["postId"] }, { fields: ["createdAt"] }] },
);

export const follows = app.collection(
  "follows",
  { followerId: s.ref(profiles), followeeId: s.ref(profiles), createdAt: s.number() },
  { unique: [["followerId", "followeeId"]], indexes: [{ fields: ["followeeId"] }] },
);

export const comments = app.collection(
  "comments",
  {
    postId: s.ref(posts),
    authorId: s.ref(profiles),
    /** The comment this replies to (same post), for threads. */
    parentId: s.optional(s.string()),
    /** A top-level comment (no parent): what a conversation is paged by. */
    root: s.boolean(),
    /** Empty once deleted while it still has replies (a tombstone keeps the thread whole). */
    text: s.string({ maxLength: 1000 }),
    viaAgentId: s.optional(s.string()),
    createdAt: s.number(),
    editedAt: s.optional(s.number()),
    deletedAt: s.optional(s.number()),
  },
  { indexes: [{ fields: ["postId", "createdAt"] }, { fields: ["postId", "root", "createdAt"] }, { fields: ["parentId"] }, { fields: ["authorId"] }] },
);

/**
 * One reaction per participant per post or comment (`target` is "post:<id>" or "comment:<id>").
 * The unique constraint makes a duplicate or a concurrent second reaction impossible; counts are
 * computed from these records, never stored.
 */
export const reactions = app.collection(
  "reactions",
  {
    postId: s.ref(posts),
    commentId: s.optional(s.string()),
    target: s.string(),
    profileId: s.ref(profiles),
    kind: s.enum(REACTIONS),
    viaAgentId: s.optional(s.string()),
    createdAt: s.number(),
  },
  { unique: [["target", "profileId"]], indexes: [{ fields: ["target"] }, { fields: ["postId"] }, { fields: ["profileId"] }] },
);

/** Which notifications a participant wants. Checked when a notification would be sent. */
export const notificationSettings = app.collection(
  "notificationSettings",
  {
    profileId: s.ref(profiles),
    muted: s.array(s.enum(NOTIFICATION_TYPES)),
    /** false: nothing caused by an agent (resident or external), except your own delegated tasks. */
    fromAgents: s.boolean(),
  },
  { unique: [["profileId"]] },
);

/** An external agent asking a person to be its responsible principal. */
export const sponsorships = app.collection(
  "sponsorships",
  { agentId: s.ref(profiles), personId: s.ref(profiles), status: s.enum(["pending", "accepted", "declined"]), createdAt: s.number(), respondedAt: s.optional(s.number()) },
  { unique: [["agentId", "personId"]], indexes: [{ fields: ["personId", "createdAt"] }] },
);

/**
 * Work a person delegated to an agent. The record is Frame's (the domain); whether the agent may do
 * it is AuthBoundry's answer at the moment it acts (`decisionId`, `delegationId` are its evidence).
 */
export const tasks = app.collection(
  "tasks",
  {
    ownerId: s.ref(profiles),
    agentId: s.ref(profiles),
    kind: s.enum(["publish", "react", "digest"]),
    capability: s.enum(Object.keys(DELEGABLE) as [DelegableCapability, ...DelegableCapability[]]),
    /** scheduled → running → completed | failed | needs_permission; "active" for standing work (react); cancelled by the owner. */
    status: s.enum(["scheduled", "active", "completed", "failed", "needs_permission", "cancelled"]),
    draft: s.optional(
      s.object({
        text: s.string({ maxLength: 2200 }),
        visibility: s.enum(["public", "followers"]),
        media: s.array(s.object({ fileId: s.string(), width: s.integer({ minimum: 1 }), height: s.integer({ minimum: 1 }) }), { maxItems: 10 }),
      }),
    ),
    runAt: s.number(),
    runs: s.integer({ minimum: 0 }),
    resultPostId: s.optional(s.string()),
    summary: s.optional(s.string({ maxLength: 2000 })),
    error: s.optional(s.string({ maxLength: 500 })),
    decisionId: s.optional(s.string()),
    delegationId: s.optional(s.string()),
    createdAt: s.number(),
    updatedAt: s.number(),
  },
  { indexes: [{ fields: ["ownerId", "createdAt"] }, { fields: ["ownerId", "kind", "status"] }] },
);

/**
 * Who did what, written in the same transaction as the change (FeltKit records the caller, its type,
 * the request id and a per-subject sequence). Subject: the acting profile, and, for delegated work,
 * also the person it was done for.
 */
export const activity = app.auditTrail("activity", { subjects: ["profile"] as const, description: "Attributable activity of every participant." });

// ---------------------------------------------------------------------------------------------------
// Migrations (never rename or edit one that ran).

const TOPIC = /#([\p{L}\p{N}_]{2,40})/gu;
const topicsIn = (text: string) => [...new Set([...text.matchAll(TOPIC)].map((m) => m[1]!.toLowerCase()))].slice(0, 10);

app.migration("frame 2: agents, media, reactions, threads", async (m) => {
  // Every existing profile is a person.
  await m.update(profiles, (p) => ({ ...p, kind: p.kind ?? "person", interests: p.interests ?? [], skills: p.skills ?? [] }));
  // A post's photo moves to `media`; the caption becomes the post's text; topics are indexed.
  for (const p of await m.records(posts)) {
    if (typeof p.fileId !== "string") continue;
    const text = String(p.caption ?? "");
    const topics = topicsIn(text);
    m.put(media, `media-${p.id}`, { postId: p.id, fileId: p.fileId, width: p.width, height: p.height, position: 0 });
    topics.forEach((topic, i) => m.put(postTopics, `topic-${p.id}-${i}`, { postId: p.id, topic, createdAt: p.createdAt }));
    m.put(posts, p.id, { authorId: p.authorId, text, visibility: "public", topics, createdAt: p.createdAt });
  }
  // Likes become reactions of kind "like".
  for (const l of await m.records("likes")) {
    m.put(reactions, `reaction-${l.id}`, { postId: l.postId, target: `post:${l.postId}`, profileId: l.profileId, kind: "like", createdAt: l.createdAt });
    m.delete("likes", l.id);
  }
  // Frame's resident agents join.
  for (const r of Object.values(RESIDENTS)) {
    m.put(profiles, r.profileId, {
      userId: r.principal, username: r.username, displayName: r.displayName, bio: r.bio,
      kind: "agent", resident: true, interests: [...r.interests], skills: [...r.skills], createdAt: 0,
    });
  }
});

app.migration("frame 3: communities, paged conversations", async (m) => {
  // A comment without a parent is a root; conversations are paged by their roots.
  await m.update(comments, (c) => ({ ...c, root: !c.parentId }));
});

app.migration("frame 4: delegation capabilities name the action, grants name the agent", async (m) => {
  await m.update(tasks, (t) => ({ ...t, capability: String(t.capability).replace(/^concierge\./, "frame.") }));
});
