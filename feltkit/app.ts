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
  "network.followup_due",
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
    // network.*: their own professional network. feltkit.agent.read/write: their assistant's turns are
    // recorded as FeltKit agent tasks, and its reads are proposals that run as them (feltkit/assistant.ts).
    member: [...SOCIAL, "frame.delegate", "network.read", "network.write", "feltkit.agent.read", "feltkit.agent.write"],
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
    // The environment's model (any provider, chosen by the operator: Studio → Models or `feltkit model set`).
    // Optional: LinkedOut answers every question without it; the assistant asks it only to route a question
    // the rules could not interpret (feltkit/assistant.ts).
    intelligence: true,
    jobs: {
      handlers: {
        // Removing a deleted post's photo runs after the delete commits, as the person who deleted it.
        "media.release": "posts:releaseMedia",
        // A delegated task that is due hands itself to Concierge.
        "task.due": "tasks:due",
        // A follow-up's time came: remind its owner, if it is still open.
        "followup.due": "followups:due",
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
// LinkedOut: personal professional intelligence.
//
// A person's professional network is private to them. Every record below carries `ownerId`, the
// principal id of the person whose network it is, and is read and written only as that principal
// (`owner` declarations and owner-filtered reads; tests prove isolation). Facts are time-aware and
// never overwritten: a new job is a new employment, a correction supersedes evidence, a merge leaves
// the merged record in place pointing at the survivor. Strength, paths, opportunities and rankings
// are computed from these records when read, never stored (no second source of truth).

/** Where a fact came from. Inferences and model output are kinds of their own, never "observed". */
export const EVIDENCE_KINDS = ["observed", "imported", "user_provided", "inferred", "generated"] as const;
export const SOURCE_TYPES = ["linkedin_export", "csv_import", "user", "frame_profile", "frame_follow", "frame_post", "public_url", "model"] as const;
export const SENIORITY = ["ic", "manager", "director", "vp", "cxo", "founder", "unknown"] as const;
export const FUNCTIONS = ["product", "engineering", "design", "data", "research", "sales", "marketing", "operations", "finance", "people", "executive", "other"] as const;

/** Someone in the owner's professional world: a connection, a former colleague, or a person they know of. */
export const people = app.collection(
  "people",
  {
    ownerId: s.string(),
    displayName: s.string({ minLength: 1, maxLength: 120 }),
    /** Lowercase, accent-free "first last": what entity resolution compares. */
    nameKey: s.string({ maxLength: 120 }),
    headline: s.optional(s.string({ maxLength: 300 })),
    location: s.optional(s.string({ maxLength: 120 })),
    /** The Frame profile this person is, when the owner linked it (or it came from their Frame follows). */
    profileId: s.optional(s.string()),
    /** "merged": reconciled into `mergedInto`; kept so evidence about it stays interpretable. */
    status: s.enum(["active", "merged"]),
    mergedInto: s.optional(s.string()),
    createdAt: s.number(),
    updatedAt: s.number(),
  },
  { indexes: [{ fields: ["ownerId", "status", "createdAt"] }, { fields: ["ownerId", "nameKey"] }, { fields: ["ownerId", "profileId"] }], search: ["displayName", "headline"] },
);

/** Strong identifiers (an e-mail, a LinkedIn URL, a Frame profile), one owner each: what resolution matches on first. */
export const identifiers = app.collection(
  "identifiers",
  { ownerId: s.string(), personId: s.ref(people), kind: s.enum(["email", "linkedin", "frame"]), value: s.string({ maxLength: 300 }), evidenceId: s.string(), createdAt: s.number() },
  { unique: [["ownerId", "kind", "value"]], indexes: [{ fields: ["ownerId", "personId"] }] },
);

export const organizations = app.collection(
  "organizations",
  {
    ownerId: s.string(),
    name: s.string({ minLength: 1, maxLength: 160 }),
    nameKey: s.string({ maxLength: 160 }),
    domain: s.optional(s.string({ maxLength: 200 })),
    industry: s.optional(s.string({ maxLength: 120 })),
    description: s.optional(s.string({ maxLength: 500 })),
    createdAt: s.number(),
  },
  { unique: [["ownerId", "nameKey"]], indexes: [{ fields: ["ownerId", "createdAt"] }], search: ["name", "industry"] },
);

/** A position someone held. A new job is a new record; the old one ends (current: false), never disappears. */
export const employments = app.collection(
  "employments",
  {
    ownerId: s.string(),
    personId: s.ref(people),
    organizationId: s.ref(organizations),
    title: s.string({ maxLength: 200 }),
    seniority: s.enum(SENIORITY),
    function: s.enum(FUNCTIONS),
    /** ISO dates, as precise as the source ("2021", "2021-04", "2021-04-12"). */
    startDate: s.optional(s.string({ maxLength: 10 })),
    endDate: s.optional(s.string({ maxLength: 10 })),
    current: s.boolean(),
    evidenceId: s.string(),
    /** The evidence that ended it (a later position observed elsewhere, or the owner's correction). */
    endedByEvidenceId: s.optional(s.string()),
    createdAt: s.number(),
  },
  { indexes: [{ fields: ["ownerId", "personId"] }, { fields: ["ownerId", "organizationId"] }, { fields: ["ownerId", "current"] }] },
);

/** A canonical skill or domain on a person, with the evidence for it. Indexed by skill (FRAME-GAP-14's pattern). */
export const personSkills = app.collection(
  "personSkills",
  { ownerId: s.string(), personId: s.ref(people), skill: s.string({ minLength: 1, maxLength: 60 }), evidenceId: s.string(), confidence: s.number({ minimum: 0, maximum: 1 }), createdAt: s.number() },
  { unique: [["ownerId", "personId", "skill"]], indexes: [{ fields: ["ownerId", "skill"] }] },
);

/**
 * How the owner knows a person, one record per source. "direct": they know or follow them (an
 * imported connection, a Frame follow, the owner's word); "historical": a past working relationship
 * the owner recorded; "suggested": an inference, never presented as established. Second-degree and
 * public associations are computed, not stored.
 */
export const relationships = app.collection(
  "relationships",
  {
    ownerId: s.string(),
    personId: s.ref(people),
    type: s.enum(["direct", "historical", "suggested"]),
    source: s.enum(SOURCE_TYPES),
    sourceRecordId: s.optional(s.string()),
    /** ISO date the relationship began, when the source says. */
    establishedAt: s.optional(s.string({ maxLength: 10 })),
    status: s.enum(["active", "ended", "rejected"]),
    /** The owner's own assessment: 1 (barely) … 5 (close). Absent until they say. */
    closeness: s.optional(s.integer({ minimum: 1, maximum: 5 })),
    /** The owner's words: "we shipped the payments rewrite together at Acme". */
    context: s.optional(s.string({ maxLength: 500 })),
    confidence: s.number({ minimum: 0, maximum: 1 }),
    evidenceId: s.string(),
    createdAt: s.number(),
    updatedAt: s.number(),
  },
  { unique: [["ownerId", "personId", "source"]], indexes: [{ fields: ["ownerId", "type"] }] },
);

/** That two of the owner's people know each other, by the owner's word or an imported record. `aId` < `bId`. */
export const ties = app.collection(
  "ties",
  { ownerId: s.string(), aId: s.ref(people), bId: s.ref(people), basis: s.enum(["user_provided", "imported"]), context: s.optional(s.string({ maxLength: 300 })), evidenceId: s.string(), createdAt: s.number() },
  { unique: [["ownerId", "aId", "bId"]], indexes: [{ fields: ["ownerId", "bId"] }] },
);

/**
 * Every assertion's provenance. Immutable except for supersession (`verification`, `supersededBy`),
 * which is itself recorded in the ledger. `contentHash` (the assertion and its source) is unique per
 * owner, so the same fact from the same source is stored once however often it is imported.
 */
export const evidence = app.collection(
  "evidence",
  {
    ownerId: s.string(),
    subjectType: s.enum(["person", "organization", "employment", "relationship", "tie", "interaction"]),
    subjectId: s.string(),
    predicate: s.string({ maxLength: 60 }),
    objectValue: s.string({ maxLength: 2000 }),
    kind: s.enum(EVIDENCE_KINDS),
    sourceType: s.enum(SOURCE_TYPES),
    /** The import, post, follow or model generation it came from. */
    sourceReference: s.string({ maxLength: 200 }),
    sourceUri: s.optional(s.string({ maxLength: 500 })),
    /** When the fact was observed to hold (ms), when its source was published, when Frame captured it. */
    observedAt: s.number(),
    publishedAt: s.optional(s.number()),
    capturedAt: s.number(),
    validFrom: s.optional(s.string({ maxLength: 10 })),
    /** After this (ms) the fact is stale: an opportunity is no longer presented as active. */
    validUntil: s.optional(s.number()),
    confidence: s.number({ minimum: 0, maximum: 1 }),
    verification: s.enum(["unverified", "user_confirmed", "disputed", "superseded"]),
    supersededBy: s.optional(s.string()),
    contentHash: s.string(),
  },
  { unique: [["ownerId", "contentHash"]], indexes: [{ fields: ["ownerId", "subjectType", "subjectId"] }, { fields: ["ownerId", "predicate", "observedAt"] }, { fields: ["ownerId", "capturedAt"] }] },
);

/** One import of connection data. The same file twice is the same import (unique contentHash). */
export const imports = app.collection(
  "imports",
  {
    ownerId: s.string(),
    source: s.enum(["linkedin_export", "csv_import"]),
    fileName: s.string({ maxLength: 200 }),
    contentHash: s.string(),
    rows: s.integer({ minimum: 0 }),
    created: s.integer({ minimum: 0 }),
    matched: s.integer({ minimum: 0 }),
    skipped: s.array(s.object({ row: s.integer(), reason: s.string({ maxLength: 200 }) }), { maxItems: 200 }),
    createdAt: s.number(),
  },
  { unique: [["ownerId", "contentHash"]], indexes: [{ fields: ["ownerId", "createdAt"] }] },
);

/** Something that actually happened between the owner and a person. */
export const interactions = app.collection(
  "interactions",
  {
    ownerId: s.string(),
    personId: s.ref(people),
    kind: s.enum(["meeting", "call", "email", "message", "introduction", "other"]),
    occurredAt: s.number(),
    note: s.optional(s.string({ maxLength: 1000 })),
    source: s.enum(["user", "draft"]),
    evidenceId: s.string(),
    createdAt: s.number(),
  },
  { indexes: [{ fields: ["ownerId", "personId", "occurredAt"] }, { fields: ["ownerId", "occurredAt"] }] },
);

/** What the owner is looking for next. Relevance is measured against it. One per owner. */
export const goals = app.collection(
  "goals",
  {
    ownerId: s.string(),
    text: s.string({ maxLength: 300 }),
    functions: s.array(s.enum(FUNCTIONS), { maxItems: 6 }),
    domains: s.array(s.string({ maxLength: 40 }), { maxItems: 10 }),
    seniority: s.array(s.enum(SENIORITY), { maxItems: 7 }),
    organizationIds: s.array(s.string(), { maxItems: 20 }),
    updatedAt: s.number(),
  },
  { unique: [["ownerId"]] },
);

/** A message prepared for the owner to send. A draft is never sent by Frame; "sent" is the owner's confirmation. */
export const drafts = app.collection(
  "drafts",
  {
    ownerId: s.string(),
    personId: s.ref(people),
    purpose: s.enum(["reconnect", "introduction", "followup", "other"]),
    text: s.string({ maxLength: 4000 }),
    status: s.enum(["draft", "sent", "discarded"]),
    /** The evidence the draft is built on. */
    basis: s.array(s.string(), { maxItems: 30 }),
    generatedBy: s.enum(["template", "model", "user"]),
    generation: s.optional(s.object({ provider: s.string(), model: s.string(), taskId: s.optional(s.string()) })),
    sentAt: s.optional(s.number()),
    interactionId: s.optional(s.string()),
    createdAt: s.number(),
    updatedAt: s.number(),
  },
  { indexes: [{ fields: ["ownerId", "personId"] }, { fields: ["ownerId", "status", "updatedAt"] }] },
);

export const followups = app.collection(
  "followups",
  {
    ownerId: s.string(),
    personId: s.ref(people),
    dueAt: s.number(),
    reason: s.string({ minLength: 1, maxLength: 300 }),
    status: s.enum(["open", "done", "cancelled"]),
    draftId: s.optional(s.string()),
    completedAt: s.optional(s.number()),
    createdAt: s.number(),
  },
  { indexes: [{ fields: ["ownerId", "status", "dueAt"] }, { fields: ["ownerId", "personId"] }] },
);

/**
 * The history of a person's record in the owner's network: imports, corrections, merges,
 * supersessions, drafts confirmed sent. Written in the same transaction as the change.
 */
export const ledger = app.auditTrail("networkLedger", { subjects: ["person"] as const, description: "History of each person record in an owner's professional network." });

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
