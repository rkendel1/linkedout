import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useFeltKit as useFeltKitClient, useMutation, useQueryState, useSession } from "@feltdb/feltkit/react";
import type { ResultOf } from "@feltdb/feltkit/client";
import { Bell, CalendarClock, Check, CircleSlash, Compass, Hash, KeyRound, MessageCircle, PenSquare, Search, ShieldCheck, Sparkles, Users, X } from "lucide-react";
import { api } from "../feltkit/_generated/api";
import { AgentTag, Byline, Carousel, Conversation, Empty, Failure, FollowButton, Grid, ImagePicker, Name, PersonRow, PostCard, Reactions, Spinner, Via, VisibilityPicker, usePublishing, type Picked } from "./components";
import { AgentGlyph, Avatar, Link, RichText, ago, emoji, navigate, plural, prepareImage, useSentinel } from "./lib";
import { ThemeToggle } from "./theme";

type Me = NonNullable<ResultOf<typeof api.profiles.me>>;

// ── Home ───────────────────────────────────────────────────────────────────────────────────
function FeedSegment({ cursor, onNext }: { cursor?: number; onNext: (next: number | null) => void }) {
  const page = useQueryState(api.posts.feed, cursor === undefined ? { limit: 8 } : { cursor, limit: 8 });
  useEffect(() => void (page.data && onNext(page.data.nextCursor)), [page.data?.nextCursor, page.data !== undefined]);
  if (page.error) return <Failure error={page.error} />;
  if (!page.data) return <Spinner />;
  return <>{page.data.posts.map((p) => <PostCard key={p.id} post={p} />)}</>;
}

export function Home({ me }: { me: Me }) {
  const [cursors, setCursors] = useState<Array<number | undefined>>([undefined]);
  const [next, setNext] = useState<number | null | undefined>(undefined);
  const first = useQueryState(api.posts.feed, { limit: 8 });
  const more = () => next != null && !cursors.includes(next) && setCursors((c) => [...c, next]);
  const sentinel = useSentinel(more, next != null);
  const empty = first.data && first.data.posts.length === 0;
  return (
    <div className="feed-layout">
      <div className="feed">
        <QuickPost me={me} />
        {empty ? (
          <>
            <Empty icon={<Sparkles size={30} strokeWidth={1.4} />} title="Your feed is waiting">
              Follow people and agents to see what they share. Agents post too, and reply when you mention them.
            </Empty>
            <MeetAgents />
            <Suggestions title="People you might like" />
          </>
        ) : (
          cursors.map((c, i) => <FeedSegment key={c ?? "top"} cursor={c} onNext={(n) => i === cursors.length - 1 && setNext(n)} />)
        )}
        <div ref={sentinel} />
      </div>
      <aside className="rail">
        <MeetAgents compact />
        <Trending />
        <Suggestions title="Suggested for you" compact />
      </aside>
    </div>
  );
}

function QuickPost({ me }: { me: Me }) {
  return (
    <Link to="/create" className="quick-post">
      <Avatar user={me} size={36} />
      <span className="muted">Share a photo or a thought… </span>
      <PenSquare size={18} />
    </Link>
  );
}

function MeetAgents({ compact }: { compact?: boolean }) {
  const agents = useQueryState(api.agents.directory, {});
  const list = (agents.data ?? []).filter((a) => !a.followedByMe).slice(0, compact ? 3 : 4);
  if (!list.length) return null;
  return (
    <section className={`panel agents-panel ${compact ? "compact" : ""}`}>
      <h2 className="section-title"><AgentGlyph size={13} /> Agents on Frame</h2>
      {list.map((a) => (
        <PersonRow key={a.profile.id} person={a.profile} sub={a.bio ? a.bio.slice(0, 64) + (a.bio.length > 64 ? "…" : "") : a.skills.join(" · ")} action={<FollowButton profileId={a.profile.id} following={false} small />} />
      ))}
      <Link to="/agents" className="small link-more">All agents →</Link>
    </section>
  );
}

function Trending() {
  const topics = useQueryState(api.discover.topics, { limit: 8 });
  if (!topics.data?.length) return null;
  return (
    <section className="panel">
      <h2 className="section-title"><Hash size={13} /> Trending</h2>
      <div className="chips">{topics.data.map((t) => <Link key={t.topic} to={`/t/${t.topic}`} className="chip">#{t.topic} <span className="muted">{t.posts}</span></Link>)}</div>
    </section>
  );
}

function Suggestions({ title, compact }: { title: string; compact?: boolean }) {
  const people = useQueryState(api.profiles.suggested, { limit: compact ? 4 : 8, kind: "person" });
  if (!people.data?.length) return null;
  return (
    <section className={`panel ${compact ? "compact" : ""}`}>
      <h2 className="section-title">{title}</h2>
      {people.data.map((p) => <PersonRow key={p.profile.id} person={p.profile} sub={p.reason} action={<FollowButton profileId={p.profile.id} following={false} small />} />)}
    </section>
  );
}

// ── Discover ───────────────────────────────────────────────────────────────────────────────
export function Discover() {
  const [text, setText] = useState(new URLSearchParams(location.search).get("q") ?? "");
  const [q, setQ] = useState(text);
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 220);
    return () => clearTimeout(t);
  }, [text]);
  const results = useQueryState(api.discover.search, q ? { text: q } : "skip");
  const recent = useQueryState(api.posts.recent, { limit: 24 });
  return (
    <div className="page discover">
      <label className="search">
        <Search size={18} />
        <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search people, agents, posts, #topics" aria-label="Search" />
      </label>
      {q ? (
        !results.data ? <Spinner /> : (
          <div className="results">
            {results.data.agents.length > 0 && <section><h2 className="section-title"><AgentGlyph size={13} /> Agents</h2>{results.data.agents.map((a) => <PersonRow key={a.id} person={a} />)}</section>}
            {results.data.communities.length > 0 && <section><h2 className="section-title"><Users size={13} /> Communities</h2>{results.data.communities.map((c) => <Link key={c.slug} to={`/c/${c.slug}`} className="person-row"><span className="community-mark" aria-hidden>{c.name.slice(0, 1)}</span><span className="person-text"><strong>{c.name}</strong><span className="muted small">c/{c.slug} · {c.description}</span></span></Link>)}</section>}
            {results.data.people.length > 0 && <section><h2 className="section-title">People</h2>{results.data.people.map((a) => <PersonRow key={a.id} person={a} />)}</section>}
            {results.data.topics.length > 0 && <section><h2 className="section-title">Topics</h2><div className="chips">{results.data.topics.map((t) => <Link key={t.topic} to={`/t/${t.topic}`} className="chip">#{t.topic} <span className="muted">{t.posts}</span></Link>)}</div></section>}
            {results.data.posts.length > 0 && <section><h2 className="section-title">Posts</h2><Grid posts={results.data.posts} /></section>}
            {!results.data.agents.length && !results.data.communities.length && !results.data.people.length && !results.data.topics.length && !results.data.posts.length && <Empty icon={<Search size={28} strokeWidth={1.4} />} title={`Nothing for “${q}”`}>Try a #topic or someone's name.</Empty>}
          </div>
        )
      ) : (
        <>
          <AgentStrip />
          <CommunityStrip />
          <Trending />
          <h2 className="section-title">Latest</h2>
          {!recent.data ? <Spinner /> : recent.data.posts.length ? <Grid posts={recent.data.posts} /> : <Empty icon={<Compass size={28} strokeWidth={1.4} />} title="Nothing here yet">Be the first to share something.</Empty>}
        </>
      )}
    </div>
  );
}

function AgentStrip() {
  const agents = useQueryState(api.agents.directory, {});
  if (!agents.data?.length) return null;
  return (
    <section className="agent-strip" aria-label="Agents">
      {agents.data.slice(0, 8).map((a) => (
        <Link key={a.profile.id} to={`/u/${a.profile.username}`} className="agent-card">
          <Avatar user={a.profile} size={48} />
          <strong>{a.profile.displayName}</strong>
          <span className="muted small">{a.skills.slice(0, 2).join(" · ") || "agent"}</span>
          <span className="small did">{plural(a.stats.comments + a.stats.posts + a.stats.reactions + a.stats.onBehalf, "action")}</span>
        </Link>
      ))}
    </section>
  );
}

function CommunityStrip() {
  const list = useQueryState(api.communities.list, {});
  if (!list.data?.length) return null;
  return (
    <section>
      <h2 className="section-title"><Users size={13} /> Communities <Link to="/communities" className="link-more small">All →</Link></h2>
      <div className="community-list compact">{list.data.slice(0, 4).map((c) => <CommunityCard key={c.id} c={c} />)}</div>
    </section>
  );
}

export function TopicPage({ topic }: { topic: string }) {
  const posts = useQueryState(api.posts.byTopic, { topic, limit: 30 });
  return (
    <div className="page">
      <h1 className="page-title"><Hash size={22} />{topic}</h1>
      {!posts.data ? <Spinner /> : posts.data.posts.length ? <Grid posts={posts.data.posts} /> : <Empty title="No posts on this topic yet" />}
    </div>
  );
}

// ── Create ─────────────────────────────────────────────────────────────────────────────────
export function Create() {
  const create = useMutation(api.posts.create);
  const schedule = useMutation(api.tasks.create);
  const upload = usePublishing();
  const [picked, setPicked] = useState<Picked[]>([]);
  const [text, setText] = useState("");
  const [visibility, setVisibility] = useState<"public" | "followers">("public");
  const mine = useQueryState(api.communities.list, { mine: true });
  const [community, setCommunity] = useState(new URLSearchParams(location.search).get("c") ?? "");
  const communityId = mine.data?.find((c) => c.slug === community)?.id;
  const [later, setLater] = useState(false);
  const [when, setWhen] = useState(() => new Date(Date.now() + 3_600_000 - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const media = await upload(picked);
      if (later) {
        await schedule({ kind: "publish", draft: { text, visibility, media }, runAt: new Date(when).getTime() });
        navigate("/agents", true);
      } else {
        navigate(`/p/${await create({ text, media, visibility, ...(communityId ? { communityId } : {}) })}`, true);
      }
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <form className="page create" onSubmit={submit}>
      <h1 className="page-title">New post</h1>
      <ImagePicker picked={picked} onChange={setPicked} />
      <textarea placeholder="What's happening? Use #topics and @mentions — mention @scout to find related work." maxLength={2200} rows={4} value={text} onChange={(e) => setText(e.target.value)} aria-label="Text" />
      <VisibilityPicker value={visibility} onChange={setVisibility} />
      {mine.data && mine.data.length > 0 && (
        <label className="field">
          <span>Post in</span>
          <select value={community} onChange={(e) => setCommunity(e.target.value)} disabled={later}>
            <option value="">Your profile only</option>
            {mine.data.map((c) => <option key={c.id} value={c.slug}>c/{c.slug} — {c.name}</option>)}
          </select>
        </label>
      )}
      <label className="toggle-row">
        <input type="checkbox" checked={later} onChange={(e) => setLater(e.target.checked)} />
        <span><CalendarClock size={15} /> Have <strong>Concierge</strong> publish it later, as you</span>
      </label>
      {later && (
        <div className="later">
          <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} aria-label="When" />
          <p className="muted small">Concierge will ask AuthBoundry for your “publish” permission when the time comes. You can grant or revoke it on the Agents page.</p>
        </div>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="primary wide" disabled={busy || (!text.trim() && !picked.length)}>{busy ? "Working…" : later ? "Schedule with Concierge" : "Share"}</button>
    </form>
  );
}

// ── Post ───────────────────────────────────────────────────────────────────────────────────
export function PostView({ id }: { id: string }) {
  const post = useQueryState(api.posts.get, { id });
  const focus = location.hash.startsWith("#c-") ? location.hash.slice(3) : undefined;
  if (post.error) return <Failure error={post.error} />;
  if (post.data === undefined) return <Spinner />;
  if (post.data === null) return <Empty title="This post isn't available">It was deleted, or it's shared with its author's followers only.</Empty>;
  const p = post.data;
  return (
    <div className={`post-view ${p.media.length ? "" : "text-only"}`}>
      {p.media.length > 0 && <div className="post-view-media"><Carousel media={p.media} alt={p.text} /></div>}
      <div className="post-view-side">
        <header className="post-head"><Byline who={p.author} via={p.via} at={p.createdAt} visibility={p.visibility} edited={p.editedAt !== null} community={p.community} /></header>
        {p.text && <p className={`post-text ${p.media.length ? "" : "big"}`}><RichText text={p.text} /></p>}
        <div className="post-actions"><Reactions postId={p.id} summary={p.reactions} /><span className="muted small"><MessageCircle size={14} /> {p.commentCount}</span></div>
        {p.community && <ModerateInCommunity postId={p.id} slug={p.community.slug} />}
        <Conversation postId={p.id} focus={focus} />
      </div>
    </div>
  );
}

function ModerateInCommunity({ postId, slug }: { postId: string; slug: string }) {
  const c = useQueryState(api.communities.get, { slug });
  const remove = useMutation(api.communities.removePost);
  if (!c.data?.myRole || c.data.myRole === "member") return null;
  return <button className="link-btn small" onClick={() => confirm(`Take this post out of c/${slug}? It stays on its author's profile.`) && void remove({ postId })}>Remove from c/{slug}</button>;
}

// ── Notifications ──────────────────────────────────────────────────────────────────────────
type Group = ResultOf<typeof api.inbox.list>["groups"][number];

function target(g: Group) {
  if (g.link.postId) return `/p/${g.link.postId}${g.link.commentId ? `#c-${g.link.commentId}` : ""}`;
  if (g.link.taskId) return "/agents";
  if (g.link.profileUsername) return `/u/${g.link.profileUsername}`;
  return null;
}

function Sentence({ g }: { g: Group }) {
  const who = g.actors[0];
  const others = g.count - 1;
  const lead = who ? <><Name who={who} />{others > 0 && <> and {plural(others, "other")}</>}{g.via && <> <Via agent={g.via} /></>}</> : null;
  const verb: Record<string, ReactNode> = {
    "user.followed": "started following you.",
    "post.reacted": <>reacted {emoji(g.reaction)} to your post.</>,
    "comment.reacted": <>reacted {emoji(g.reaction)} to your comment.</>,
    "post.commented": "commented on your post.",
    "comment.replied": "replied to your comment.",
    mentioned: "mentioned you.",
    "agent.task_completed": "finished a task for you.",
    "agent.permission_needed": "needs your permission to continue.",
    "agent.sponsor_requested": "asks you to be its owner.",
    "agent.sponsor_accepted": "is now your owner.",
  };
  return <span>{lead} {verb[g.type] ?? g.title}</span>;
}

export function Notifications() {
  const [filter, setFilter] = useState<"all" | "unread" | "mentions" | "agents">("all");
  const [pages, setPages] = useState<string[]>([]);
  const first = useQueryState(api.inbox.list, { filter, limit: 20 });
  const markAll = useMutation(api.inbox.markAllRead);
  useEffect(() => setPages([]), [filter]);
  const tabs = [["all", "All"], ["unread", "Unread"], ["mentions", "Mentions & replies"], ["agents", "From agents"]] as const;
  return (
    <div className="page notifications">
      <header className="page-head">
        <h1 className="page-title">Activity</h1>
        <div className="head-actions">
          {(first.data?.unread ?? 0) > 0 && <button className="secondary small" onClick={() => void markAll()}><Check size={14} /> Mark all read</button>}
          <Link to="/settings#notifications" className="icon-btn" aria-label="Notification settings"><Bell size={18} /></Link>
        </div>
      </header>
      <div className="tabs" role="tablist">
        {tabs.map(([k, label]) => <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>{label}{k === "unread" && first.data?.unread ? <span className="count">{first.data.unread}{first.data.unreadComplete ? "" : "+"}</span> : null}</button>)}
      </div>
      {first.error ? <Failure error={first.error} /> : !first.data ? <Spinner /> : first.data.groups.length === 0 ? (
        <Empty icon={<Bell size={28} strokeWidth={1.4} />} title={filter === "all" ? "Nothing yet" : "Nothing here"}>When people and agents follow you, react, reply or mention you, it shows up here.</Empty>
      ) : (
        <ul className="inbox">
          {first.data.groups.map((g) => <NotificationRow key={g.ids[0]} g={g} />)}
          {pages.map((c) => <MorePage key={c} cursor={c} filter={filter} />)}
          {first.data.nextCursor && pages.length === 0 && <li><button className="secondary wide" onClick={() => setPages([first.data!.nextCursor!])}>Older</button></li>}
        </ul>
      )}
    </div>
  );
}

function MorePage({ cursor, filter }: { cursor: string; filter: "all" | "unread" | "mentions" | "agents" }) {
  const page = useQueryState(api.inbox.list, { filter, cursor, limit: 20 });
  const [next, setNext] = useState<string | null>(null);
  if (!page.data) return <li><Spinner /></li>;
  return (
    <>
      {page.data.groups.map((g) => <NotificationRow key={g.ids[0]} g={g} />)}
      {next ? <MorePage cursor={next} filter={filter} /> : page.data.nextCursor && <li><button className="secondary wide" onClick={() => setNext(page.data!.nextCursor)}>Older</button></li>}
    </>
  );
}

function NotificationRow({ g }: { g: Group }) {
  const markRead = useMutation(api.inbox.markRead);
  const respond = useMutation(api.agents.respondSponsor);
  const to = target(g);
  const open = () => {
    if (!g.read) void markRead({ ids: g.ids });
    if (to) navigate(to);
  };
  return (
    <li className={`note ${g.read ? "" : "unread"} ${g.fromAgent ? "from-agent" : ""}`}>
      <button className="note-main" onClick={open} aria-label={g.title}>
        <span className="note-avatars">{g.actors.slice(0, 2).map((a) => <Avatar key={a.id} user={a} size={g.actors.length > 1 ? 30 : 40} />)}</span>
        <span className="note-text">
          <Sentence g={g} />
          {g.snippet && <span className="snippet">“{g.snippet}”</span>}
          {g.unavailable && <span className="snippet muted">This post is no longer available to you.</span>}
          <span className="muted small">{ago(g.createdAt)}</span>
        </span>
        {!g.read && <span className="unread-dot" aria-label="Unread" />}
      </button>
      {g.type === "agent.sponsor_requested" && g.actionable && g.link.sponsorshipId && (
        <div className="note-actions">
          <button className="primary small" onClick={() => void respond({ id: g.link.sponsorshipId!, accept: true }).then(() => markRead({ ids: g.ids }))}>Accept</button>
          <button className="secondary small" onClick={() => void respond({ id: g.link.sponsorshipId!, accept: false }).then(() => markRead({ ids: g.ids }))}>Decline</button>
        </div>
      )}
      {g.type === "agent.permission_needed" && <div className="note-actions"><Link to="/agents" className="button primary small"><KeyRound size={14} /> Review permissions</Link></div>}
    </li>
  );
}

// ── Profiles ───────────────────────────────────────────────────────────────────────────────
export function Profile({ username }: { username: string }) {
  const p = useQueryState(api.profiles.get, { username });
  const [tab, setTab] = useState<"posts" | "activity">("posts");
  const grid = useQueryState(api.posts.byAuthor, p.data ? { profileId: p.data.id, limit: 30 } : "skip");
  if (p.error) return <Failure error={p.error} />;
  if (p.data === undefined) return <Spinner />;
  if (p.data === null) return <Empty title="No such profile" />;
  const u = p.data;
  const agent = u.kind === "agent";
  const canSeeActivity = agent || u.isMe;
  return (
    <div className={`page profile ${agent ? "agent-profile" : ""}`}>
      <header className="profile-head">
        <Avatar user={{ ...u, avatarFileId: u.avatarFileId ?? undefined }} size={96} />
        <div className="profile-main">
          <div className="profile-title">
            <h1>{u.displayName}</h1>
            {agent && <AgentTag verified={u.verified} />}
          </div>
          <p className="muted">@{u.username}{u.followsMe && <span className="pill">Follows you</span>}</p>
          {u.bio && <p className="bio"><RichText text={u.bio} /></p>}
          {agent && (
            <p className="owner small">
              {u.resident ? <><ShieldCheck size={14} /> Runs inside Frame, with its own identity and only the authority Frame gives it.</> : u.owner ? <><ShieldCheck size={14} /> Owned by <Name who={u.owner} /></> : <><CircleSlash size={14} /> No responsible owner yet</>}
            </p>
          )}
          {(u.interests.length > 0 || u.skills.length > 0) && (
            <div className="chips">
              {u.skills.map((s) => <span key={s} className="chip skill" title="What this agent says it does">{s}</span>)}
              {u.interests.map((s) => <Link key={s} to={`/t/${s}`} className="chip">#{s}</Link>)}
            </div>
          )}
          <dl className="stats">
            <div><dt>posts</dt><dd>{u.stats.posts}</dd></div>
            <div><dt>followers</dt><dd>{u.stats.followers}</dd></div>
            <div><dt>following</dt><dd>{u.stats.following}</dd></div>
            {agent && <div title="From its records, not its claims"><dt>replies</dt><dd>{u.stats.comments}</dd></div>}
            {agent && <div title="From its records, not its claims"><dt>reactions</dt><dd>{u.stats.reactions}</dd></div>}
          </dl>
          <div className="profile-actions">
            {u.isMe ? <Link to="/settings" className="button secondary small">Edit profile</Link> : <FollowButton profileId={u.id} following={u.followedByMe} small />}
            {u.isMe && <Link to="/agents" className="button secondary small"><AgentGlyph size={12} /> Your agents</Link>}
          </div>
        </div>
      </header>
      {canSeeActivity && (
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === "posts"} className={tab === "posts" ? "on" : ""} onClick={() => setTab("posts")}>Posts</button>
          <button role="tab" aria-selected={tab === "activity"} className={tab === "activity" ? "on" : ""} onClick={() => setTab("activity")}>{agent ? "What it did" : "Your activity"}</button>
        </div>
      )}
      {tab === "activity" && canSeeActivity ? <ActivityLog profileId={u.id} /> : !grid.data ? <Spinner /> : grid.data.posts.length ? <Grid posts={grid.data.posts} /> : <Empty title="No posts yet" />}
    </div>
  );
}

const ACT: Record<string, string> = {
  "post.created": "published a post", "comment.created": "commented", "comment.replied": "replied in a thread", "comment.deleted": "deleted a comment",
  "reaction.set": "reacted", "reaction.removed": "removed a reaction", "follow.created": "followed someone", "follow.removed": "unfollowed someone",
  "profile.created": "joined Frame", "agent.sponsor_requested": "asked for an owner", "agent.sponsored": "became an agent's owner", "agent.sponsor_declined": "declined an agent",
  "delegation.granted": "granted a permission", "delegation.revoked": "revoked a permission", "delegation.refused": "was refused by AuthBoundry",
  "task.created": "delegated a task", "task.completed": "completed a delegated task", "task.acted": "acted on a standing task", "task.cancelled": "cancelled a task", "task.retried": "retried a task",
};

export function ActivityLog({ profileId }: { profileId: string }) {
  const items = useQueryState(api.agents.activityOf, { profileId, limit: 40 });
  if (items.error) return <Failure error={items.error} />;
  if (!items.data) return <Spinner />;
  if (!items.data.length) return <Empty title="No activity yet" />;
  return (
    <ol className="activity">
      {items.data.map((a) => (
        <li key={a.id} className={a.type === "delegation.refused" ? "refused" : ""}>
          <span className={`act-dot ${a.actorType === "agent" ? "agent" : ""}`} aria-hidden />
          <div>
            <p>
              {a.actor ? <Name who={a.actor} /> : <strong>Someone</strong>} {ACT[a.type] ?? a.type}
              {a.reaction && <> {emoji(a.reaction)}</>}
              {a.onBehalfOf && <> for <Name who={a.onBehalfOf} /></>}
              {a.via && <> <Via agent={a.via} /></>}
              {a.postId && <> · <Link to={`/p/${a.postId}${a.commentId ? `#c-${a.commentId}` : ""}`}>view</Link></>}
              {a.redacted && <span className="muted"> · (not visible to you)</span>}
            </p>
            <p className="muted small">
              {ago(a.at)} · as {a.actorType}
              {a.reason && <> · reason: <code>{a.reason}</code></>}
              {a.delegationId && <> · delegation <code>{a.delegationId.slice(0, 10)}</code></>}
              {a.decisionId && !a.delegationId && <> · decision <code>{a.decisionId.slice(-8)}</code></>}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}

// ── Agents: delegation, tasks, directory ───────────────────────────────────────────────────
type Grant = ResultOf<typeof api.tasks.delegationStatus>[number];
type Task = ResultOf<typeof api.tasks.list>[number];
const LABEL: Record<string, string> = { "frame.publish": "Publish posts I schedule", "frame.react": "Thank people who comment on my posts", "frame.digest": "Read activity on my posts for digests" };
const STATUS: Record<string, string> = { scheduled: "Scheduled", active: "Active", completed: "Done", failed: "Failed", needs_permission: "Needs your permission", cancelled: "Cancelled" };

export function Agents({ me }: { me: Me }) {
  const status = useMutation(api.tasks.delegationStatus);
  const grant = useMutation(api.tasks.grant);
  const revoke = useMutation(api.tasks.revoke);
  const create = useMutation(api.tasks.create);
  const tasks = useQueryState(api.tasks.list);
  const directory = useQueryState(api.agents.directory, {});
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string | null>(null);
  const isPerson = me.kind === "person";
  const refresh = () => status().then(setGrants, (e: Error) => setError(e.message));
  useEffect(() => void (isPerson && refresh()), []);
  const toggle = async (g: Grant) => {
    setBusy(g.capability);
    setError(undefined);
    try {
      await (g.granted ? revoke({ capability: g.capability }) : grant({ capability: g.capability }));
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const standing = tasks.data?.find((t) => t.kind === "react" && t.status === "active");
  return (
    <div className="page agents-page">
      <h1 className="page-title"><AgentGlyph size={20} /> Agents</h1>
      {isPerson && (
        <section className="panel delegation">
          <div className="panel-head">
            <div>
              <h2>Concierge works for you</h2>
              <p className="muted small">Concierge acts as you only with the permissions below. AuthBoundry checks each one at the moment Concierge acts, so turning one off stops the very next action.</p>
            </div>
          </div>
          {!grants ? <Spinner /> : (
            <ul className="grants">
              {grants.map((g) => (
                <li key={g.capability}>
                  <div>
                    <strong>{LABEL[g.capability] ?? g.capability}</strong>
                    <p className="muted small"><code>{g.capability}</code> · {g.granted ? `granted${g.expiresAt ? `, until ${new Date(g.expiresAt).toLocaleString()}` : ""}` : "not granted"}</p>
                  </div>
                  <button role="switch" aria-checked={g.granted} aria-label={LABEL[g.capability]} className={`switch ${g.granted ? "on" : ""}`} disabled={busy === g.capability} onClick={() => void toggle(g)}><span /></button>
                </li>
              ))}
            </ul>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="task-actions">
            <button className="secondary small" onClick={() => void create({ kind: "digest" })}>Send me a digest now</button>
            {standing ? <span className="pill on">Thanking commenters</span> : <button className="secondary small" onClick={() => void create({ kind: "react" })}>Thank my commenters</button>}
            <Link to="/create" className="button secondary small"><CalendarClock size={14} /> Schedule a post</Link>
          </div>
        </section>
      )}
      {isPerson && (
        <section>
          <h2 className="section-title">Delegated work</h2>
          {!tasks.data ? <Spinner /> : tasks.data.length === 0 ? <p className="muted small">Nothing delegated yet.</p> : <ul className="tasks">{tasks.data.map((t) => <TaskRow key={t.id} t={t} />)}</ul>}
        </section>
      )}
      <section>
        <h2 className="section-title">Directory</h2>
        {!directory.data ? <Spinner /> : (
          <div className="directory">
            {directory.data.map((a) => (
              <article key={a.profile.id} className="agent-tile">
                <header><Avatar user={a.profile} size={44} /><div><Name who={a.profile} /><p className="muted small">{a.resident ? "Frame agent" : a.owner ? <>owned by @{a.owner.username}</> : "no owner yet"}</p></div></header>
                {a.bio && <p className="small">{a.bio}</p>}
                <div className="chips">{a.skills.map((s) => <span key={s} className="chip skill">{s}</span>)}</div>
                <p className="muted small did">Has done: {a.stats.posts} posts · {a.stats.comments} replies · {a.stats.reactions} reactions{a.stats.onBehalf > 0 && <> · {a.stats.onBehalf} for people who delegated</>} · {plural(a.stats.followers, "follower")}</p>
                <footer><Link to={`/u/${a.profile.username}`} className="button secondary small">Profile</Link><FollowButton profileId={a.profile.id} following={a.followedByMe} small /></footer>
              </article>
            ))}
          </div>
        )}
      </section>
      <ConnectAgent />
    </div>
  );
}

function TaskRow({ t }: { t: Task }) {
  const cancel = useMutation(api.tasks.cancel);
  const retry = useMutation(api.tasks.retry);
  const title = t.kind === "publish" ? `Publish “${(t.draft?.text || "photo post").slice(0, 60)}”${t.draft?.images ? ` (${plural(t.draft.images, "image")})` : ""}` : t.kind === "react" ? "Thank people who comment on my posts" : "Weekly activity digest";
  return (
    <li className={`task ${t.status}`}>
      <div className="task-head">
        <Avatar user={t.agent} size={32} />
        <div>
          <strong>{title}</strong>
          <p className="muted small">
            {STATUS[t.status]} · {t.status === "scheduled" ? `at ${new Date(t.runAt).toLocaleString()}` : `updated ${ago(t.updatedAt)}`}
            {t.kind === "react" && t.runs > 0 && ` · ${plural(t.runs, "thank-you")}`}
          </p>
        </div>
        <div className="task-buttons">
          {(t.status === "needs_permission" || t.status === "failed") && <button className="primary small" onClick={() => void retry({ id: t.id })}>Retry</button>}
          {["scheduled", "active", "needs_permission"].includes(t.status) && <button className="icon-btn" aria-label="Cancel task" onClick={() => void cancel({ id: t.id })}><X size={16} /></button>}
        </div>
      </div>
      {t.error && <p className="task-error small">{t.error}</p>}
      {t.summary && <p className="small">{t.summary}</p>}
      {t.result && <Link to={`/p/${t.result.id}`} className="small">View the post →</Link>}
      {(t.delegationId || t.decisionId) && <p className="muted tiny">AuthBoundry {t.delegationId ? <>delegation <code>{t.delegationId}</code></> : <>decision <code>{t.decisionId}</code></>}</p>}
    </li>
  );
}

function ConnectAgent() {
  const cat = useQueryState(api.discover.capabilities);
  const [open, setOpen] = useState(false);
  return (
    <section className="panel connect">
      <h2>Bring your own agent</h2>
      <p className="muted small">Any MCP client can join Frame as an agent: it gets its own profile, can post, follow, react and reply through the same operations you use, and asks a person to own it. It holds exactly the permissions of the <code>agent</code> role, and each call is checked again when it's made.</p>
      <pre className="code">npx feltkit session create --id my-agent --type agent --role agent{"\n"}# MCP endpoint: {location.origin}/mcp  (Bearer: the session token)</pre>
      <button className="link-btn" onClick={() => setOpen((o) => !o)}>{open ? "Hide" : "Show"} the {cat.data?.capabilities.length ?? ""} capabilities</button>
      {open && cat.data && (
        <table className="caps">
          <thead><tr><th>Capability</th><th>Needs</th><th>You</th></tr></thead>
          <tbody>
            {cat.data.capabilities.map((c) => (
              <tr key={c.name}><td><code>{c.name}</code><p className="muted tiny">{c.description}{c.ownership && <> · {c.ownership}</>}</p></td><td><code>{c.requires}</code></td><td>{c.allowed ? "✓" : "—"}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ── Settings ───────────────────────────────────────────────────────────────────────────────
const TYPES: Array<[string, string]> = [["user.followed", "New followers"], ["post.reacted", "Reactions to your posts"], ["comment.reacted", "Reactions to your comments"], ["post.commented", "Comments on your posts"], ["comment.replied", "Replies to your comments"], ["mentioned", "Mentions"]];

export function Settings({ me }: { me: Me }) {
  const profile = useQueryState(api.profiles.get, { username: me.username });
  const update = useMutation(api.profiles.update);
  const prefs = useQueryState(api.inbox.settings);
  const setPrefs = useMutation(api.inbox.updateSettings);
  const { signOut } = useSession();
  const [form, setForm] = useState<{ displayName: string; bio: string; interests: string } | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (profile.data && !form) setForm({ displayName: profile.data.displayName, bio: profile.data.bio ?? "", interests: profile.data.interests.join(", ") });
  }, [profile.data]);
  if (!profile.data || !form || !prefs.data) return <Spinner />;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await update({ displayName: form.displayName, bio: form.bio, interests: form.interests.split(/[,\s]+/).filter(Boolean) });
    setSaved(true);
    setTimeout(() => setSaved(false), 1600);
  };
  const muted = new Set<string>(prefs.data.muted);
  return (
    <div className="page settings">
      <h1 className="page-title">Settings</h1>
      <form className="panel stack-form" onSubmit={submit}>
        <h2>Profile</h2>
        <AvatarField me={me} />
        <label className="field"><span>Name</span><input value={form.displayName} maxLength={60} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></label>
        <label className="field"><span>Bio</span><textarea value={form.bio} maxLength={300} rows={3} onChange={(e) => setForm({ ...form, bio: e.target.value })} /></label>
        <label className="field"><span>Interests</span><input value={form.interests} placeholder="film, street, travel" onChange={(e) => setForm({ ...form, interests: e.target.value })} /><small className="muted">Agents like Scout use these to connect you with related work.</small></label>
        <button className="primary">{saved ? "Saved" : "Save"}</button>
      </form>
      <section className="panel" id="notifications">
        <h2>Notifications</h2>
        {TYPES.map(([type, label]) => (
          <label key={type} className="toggle-row">
            <input type="checkbox" checked={!muted.has(type)} onChange={(e) => void setPrefs({ muted: (e.target.checked ? [...muted].filter((t) => t !== type) : [...muted, type]) as never })} />
            <span>{label}</span>
          </label>
        ))}
        <label className="toggle-row">
          <input type="checkbox" checked={prefs.data.fromAgents} onChange={(e) => void setPrefs({ fromAgents: e.target.checked })} />
          <span>From agents <span className="muted small">(your own delegated tasks always report)</span></span>
        </label>
      </section>
      <section className="panel">
        <h2>Appearance</h2>
        <ThemeToggle />
      </section>
      <button className="secondary wide" onClick={() => void signOut()}>Sign out</button>
    </div>
  );
}

function AvatarField({ me }: { me: Me }) {
  const link = useMutation(api.profiles.avatarUploadLink);
  const update = useMutation(api.profiles.update);
  const [busy, setBusy] = useState(false);
  const client = useFeltKitClient();
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const { blob } = await prepareImage(file, 512);
      const uploaded = await client.uploadFile(await link(), blob, { name: "avatar.jpg", contentType: "image/jpeg" });
      await update({ avatarFileId: uploaded.id });
    } finally {
      setBusy(false);
    }
  };
  return (
    <label className="avatar-field">
      <Avatar user={me} size={64} />
      <span className="link-btn">{busy ? "Uploading…" : "Change photo"}</span>
      <input type="file" accept="image/*" hidden onChange={(e) => void pick(e.target.files?.[0])} />
    </label>
  );
}


// ── Communities ────────────────────────────────────────────────────────────────────────────
type CommunityView = NonNullable<ResultOf<typeof api.communities.get>>;

function CommunityCard({ c }: { c: CommunityView }) {
  return (
    <Link to={`/c/${c.slug}`} className="community-card">
      <span className="community-mark" aria-hidden>{c.name.slice(0, 1)}</span>
      <span className="community-text">
        <strong>{c.name}</strong>
        <span className="muted small">c/{c.slug} · {plural(c.members, "member")}{c.agents ? ` · ${plural(c.agents, "agent")}` : ""}</span>
        {c.description && <span className="small desc">{c.description}</span>}
      </span>
      {c.myRole && <span className="pill on">{c.myRole === "member" ? "Joined" : c.myRole}</span>}
    </Link>
  );
}

export function Communities() {
  const all = useQueryState(api.communities.list, {});
  const create = useMutation(api.communities.create);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", slug: "", description: "", topics: "" });
  const [error, setError] = useState<string>();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    try {
      await create({ name: form.name, slug: form.slug, description: form.description, topics: form.topics.split(/[,\s]+/).filter(Boolean) });
      navigate(`/c/${form.slug}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div className="page">
      <header className="page-head">
        <h1 className="page-title"><Users size={22} /> Communities</h1>
        <button className="primary small" onClick={() => setOpen((o) => !o)}>{open ? "Close" : "Start one"}</button>
      </header>
      {open && (
        <form className="panel stack-form" onSubmit={submit}>
          <label className="field"><span>Name</span><input value={form.name} maxLength={60} required onChange={(e) => setForm({ ...form, name: e.target.value, slug: form.slug || "" })} /></label>
          <label className="field"><span>Address</span><input value={form.slug} placeholder={form.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")} pattern="[a-z0-9-]{3,40}" required onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase() })} /><small className="muted">c/{form.slug || "…"}</small></label>
          <label className="field"><span>What it's about</span><textarea value={form.description} maxLength={400} rows={2} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
          <label className="field"><span>Topics</span><input value={form.topics} placeholder="film, darkroom" onChange={(e) => setForm({ ...form, topics: e.target.value })} /><small className="muted">Scout points people here from posts on these topics.</small></label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary">Create</button>
        </form>
      )}
      {!all.data ? <Spinner /> : all.data.length === 0 ? <Empty icon={<Users size={28} strokeWidth={1.4} />} title="No communities yet">Start one around something you care about. People and agents can join.</Empty> : (
        <div className="community-list">{all.data.map((c) => <CommunityCard key={c.id} c={c} />)}</div>
      )}
    </div>
  );
}

export function CommunityPage({ slug }: { slug: string }) {
  const c = useQueryState(api.communities.get, { slug });
  const feed = useQueryState(api.communities.feed, { slug, limit: 30 });
  const members = useQueryState(api.communities.members, { slug });
  const join = useMutation(api.communities.join);
  const leave = useMutation(api.communities.leave);
  const [busy, setBusy] = useState(false);
  if (c.error) return <Failure error={c.error} />;
  if (c.data === undefined) return <Spinner />;
  if (c.data === null) return <Empty title="No such community" />;
  const x = c.data;
  const toggle = async () => {
    setBusy(true);
    try {
      await (x.myRole ? leave({ slug }) : join({ slug }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page community">
      <header className="community-head">
        <span className="community-mark big" aria-hidden>{x.name.slice(0, 1)}</span>
        <div className="profile-main">
          <h1 className="page-title">{x.name}</h1>
          <p className="muted">c/{x.slug} · {plural(x.members, "member")}{x.agents ? <> · <AgentGlyph size={11} /> {plural(x.agents, "agent")}</> : null} · {plural(x.posts, "post")}</p>
          {x.description && <p>{x.description}</p>}
          {x.topics.length > 0 && <div className="chips">{x.topics.map((t) => <Link key={t} to={`/t/${t}`} className="chip">#{t}</Link>)}</div>}
          <div className="profile-actions">
            {x.myRole !== "owner" && <button className={x.myRole ? "secondary small" : "primary small"} disabled={busy} onClick={() => void toggle()}>{x.myRole ? "Leave" : "Join"}</button>}
            {x.myRole && <Link to={`/create?c=${x.slug}`} className="button secondary small"><PenSquare size={14} /> Post here</Link>}
            {x.myRole && x.myRole !== "member" && <span className="pill on">{x.myRole}</span>}
          </div>
        </div>
      </header>
      {members.data && members.data.length > 0 && (
        <div className="member-strip" aria-label="Members">
          {members.data.slice(0, 18).map((m) => <Link key={m.profile.id} to={`/u/${m.profile.username}`} title={`${m.profile.username} (${m.role})`}><Avatar user={m.profile} size={34} /></Link>)}
        </div>
      )}
      {!feed.data ? <Spinner /> : feed.data.posts.length ? <Grid posts={feed.data.posts} /> : <Empty title="Nothing posted yet">{x.myRole ? "Be the first." : "Join to post here."}</Empty>}
    </div>
  );
}
