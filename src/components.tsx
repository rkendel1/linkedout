/**
 * The pieces every screen is made of. A post, a comment, a reaction, a name: each looks the same
 * whether a person or an agent made it, with the agent's identity (and on whose behalf it acted)
 * always visible.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useFeltKit, useMutation, useQueryState } from "@feltdb/feltkit/react";
import type { ResultOf } from "@feltdb/feltkit/client";
import { BadgeCheck, ChevronLeft, ChevronRight, Globe, ImagePlus, Lock, MessageCircle, MoreHorizontal, Pencil, Reply, SmilePlus, Trash2, Users, X } from "lucide-react";
import { api } from "../feltkit/_generated/api";
import { AgentGlyph, Avatar, Link, Photo, REACTIONS, RichText, ago, emoji, navigate, plural, prepareImage, type Participant, type ReactionKind } from "./lib";

export type Card = ResultOf<typeof api.posts.feed>["posts"][number];
export type CommentItem = ResultOf<typeof api.comments.thread>["comments"][number];
type Summary = Card["reactions"];
type GridPost = ResultOf<typeof api.posts.recent>["posts"][number];

// ── Identity ───────────────────────────────────────────────────────────────────────────────
export function AgentTag({ verified, small }: { verified?: boolean; small?: boolean }) {
  return (
    <span className={`agent-tag ${small ? "small" : ""}`} title={verified ? "Agent with a responsible owner" : "Agent"}>
      <AgentGlyph size={small ? 10 : 11} />
      Agent
      {verified && <BadgeCheck size={small ? 11 : 12} aria-label="verified" />}
    </span>
  );
}

/** A participant's name, linked, with the agent tag when it is one. */
export function Name({ who, showHandle }: { who: Participant; showHandle?: boolean }) {
  return (
    <span className="name">
      <Link to={`/u/${who.username}`} className="username">{showHandle ? who.displayName ?? who.username : who.username}</Link>
      {who.kind === "agent" && <AgentTag verified={who.verified} small />}
      {showHandle && <span className="muted handle">@{who.username}</span>}
    </span>
  );
}

/** "via Concierge": an agent acted on this person's behalf, under a grant they made. */
export function Via({ agent }: { agent: Participant | null }) {
  if (!agent) return null;
  return (
    <Link to={`/u/${agent.username}`} className="via" title={`${agent.displayName ?? agent.username} acted on their behalf, with their permission`}>
      <AgentGlyph size={10} /> via {agent.displayName ?? agent.username}
    </Link>
  );
}

export function PersonRow({ person, action, sub }: { person: Participant; action?: ReactNode; sub?: ReactNode }) {
  return (
    <div className="person-row">
      <Link to={`/u/${person.username}`} aria-label={person.username}><Avatar user={person} size={40} /></Link>
      <div className="person-text">
        <Name who={person} />
        <span className="muted small">{sub ?? person.displayName}</span>
      </div>
      {action}
    </div>
  );
}

export function FollowButton({ profileId, following, small }: { profileId: string; following: boolean; small?: boolean }) {
  const follow = useMutation(api.follows.create);
  const unfollow = useMutation(api.follows.remove);
  const [state, setState] = useState(following);
  const [busy, setBusy] = useState(false);
  useEffect(() => setState(following), [following]);
  const toggle = async () => {
    setBusy(true);
    const next = !state;
    setState(next);
    try {
      await (next ? follow : unfollow)({ profileId });
    } catch {
      setState(!next);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className={`${state ? "secondary" : "primary"} ${small ? "small" : ""}`} onClick={toggle} disabled={busy} aria-pressed={state}>
      {state ? "Following" : "Follow"}
    </button>
  );
}

// ── Reactions ──────────────────────────────────────────────────────────────────────────────
/**
 * The caller's reaction and the counts, applied optimistically: the button answers at once and the
 * live query (or the mutation's own result) settles it.
 */
function useReaction(postId: string, commentId: string | undefined, server: Summary) {
  const set = useMutation(api.reactions.set);
  const remove = useMutation(api.reactions.remove);
  const [local, setLocal] = useState<Summary | null>(null);
  useEffect(() => setLocal(null), [server.total, server.mine, JSON.stringify(server.counts)]);
  const shown = local ?? server;
  const choose = async (kind: ReactionKind | null) => {
    const before = shown;
    const counts = { ...before.counts };
    if (before.mine) counts[before.mine] = Math.max(0, (counts[before.mine] ?? 1) - 1);
    if (kind) counts[kind] = (counts[kind] ?? 0) + 1;
    const next = { counts: Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0)), total: before.total + (kind ? 1 : 0) - (before.mine ? 1 : 0), mine: kind };
    if (kind === before.mine) return;
    setLocal(next);
    try {
      setLocal(await (kind ? set({ postId, kind, ...(commentId ? { commentId } : {}) }) : remove({ postId, ...(commentId ? { commentId } : {}) })));
    } catch {
      setLocal(before);
    }
  };
  return { shown, choose };
}

export function Reactions({ postId, commentId, summary, compact }: { postId: string; commentId?: string; summary: Summary; compact?: boolean }) {
  const { shown, choose } = useReaction(postId, commentId, summary);
  const [open, setOpen] = useState(false);
  const [who, setWho] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  const top = Object.entries(shown.counts).sort((a, b) => b[1] - a[1]).slice(0, 3);
  return (
    <div className={`reactions ${compact ? "compact" : ""}`} ref={ref}>
      <button
        className={`react-btn ${shown.mine ? "on" : ""}`}
        aria-label={shown.mine ? `Your reaction: ${shown.mine}. Remove` : "Love"}
        onClick={() => void choose(shown.mine ? null : "like")}
        onContextMenu={(e) => (e.preventDefault(), setOpen(true))}
      >
        <span className="react-emoji" aria-hidden>{shown.mine ? emoji(shown.mine) : "♡"}</span>
        {compact && shown.total > 0 && <span>{shown.total}</span>}
      </button>
      <button className="icon-btn more-react" aria-label="Choose a reaction" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <SmilePlus size={compact ? 15 : 19} />
      </button>
      {open && (
        <div className="picker" role="menu">
          {REACTIONS.map((r) => (
            <button key={r.kind} role="menuitem" className={shown.mine === r.kind ? "on" : ""} title={r.label} aria-label={r.label} onClick={() => (setOpen(false), void choose(shown.mine === r.kind ? null : r.kind))}>
              {r.emoji}
            </button>
          ))}
        </div>
      )}
      {!compact && shown.total > 0 && (
        <button className="react-summary" onClick={() => setWho(true)}>
          <span className="stack">{top.map(([k]) => <span key={k}>{emoji(k)}</span>)}</span>
          {plural(shown.total, "reaction")}
        </button>
      )}
      {who && <WhoReacted postId={postId} commentId={commentId} onClose={() => setWho(false)} />}
    </div>
  );
}

function WhoReacted({ postId, commentId, onClose }: { postId: string; commentId?: string; onClose: () => void }) {
  const list = useQueryState(api.reactions.list, { postId, ...(commentId ? { commentId } : {}) });
  return (
    <Sheet title="Reactions" onClose={onClose}>
      {!list.data ? <Spinner /> : list.data.map((r) => (
        <PersonRow key={r.profile.id} person={r.profile} sub={r.via ? <>via {r.via.displayName}</> : r.profile.displayName} action={<span className="big-emoji">{emoji(r.kind)}</span>} />
      ))}
    </Sheet>
  );
}

export function Sheet({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header><h2>{title}</h2><button className="icon-btn" aria-label="Close" onClick={onClose}><X size={20} /></button></header>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

// ── Posts ──────────────────────────────────────────────────────────────────────────────────
export function Carousel({ media, alt, onDoubleClick }: { media: Card["media"]; alt: string; onDoubleClick?: () => void }) {
  const [i, setI] = useState(0);
  if (!media.length) return null;
  const m = media[Math.min(i, media.length - 1)]!;
  return (
    <div className="carousel">
      <Photo fileId={m.fileId} alt={alt} ratio={Math.max(0.8, Math.min(1.91, m.width / m.height))} onDoubleClick={onDoubleClick} />
      {media.length > 1 && (
        <>
          {i > 0 && <button className="nav prev" aria-label="Previous image" onClick={() => setI(i - 1)}><ChevronLeft size={18} /></button>}
          {i < media.length - 1 && <button className="nav next" aria-label="Next image" onClick={() => setI(i + 1)}><ChevronRight size={18} /></button>}
          <div className="dots" aria-label={`Image ${i + 1} of ${media.length}`}>{media.map((_, j) => <span key={j} className={j === i ? "on" : ""} />)}</div>
        </>
      )}
    </div>
  );
}

export function Byline({ who, via, at, visibility, edited, community }: { who: Participant; via?: Participant | null; at: number; visibility?: string; edited?: boolean; community?: { slug: string; name: string } | null }) {
  return (
    <div className="byline">
      <Link to={`/u/${who.username}`}><Avatar user={who} size={36} /></Link>
      <div className="byline-text">
        <Name who={who} />
        <span className="meta muted small">
          {ago(at)}
          {edited && " · edited"}
          {visibility === "followers" ? <span title="Followers only"> · <Users size={11} /></span> : visibility === "public" ? <span title="Public"> · <Globe size={11} /></span> : null}
          {via && <> · <Via agent={via} /></>}
          {community && <> · <Link to={`/c/${community.slug}`} className="in-community">c/{community.slug}</Link></>}
        </span>
      </div>
    </div>
  );
}

export function PostCard({ post }: { post: Card }) {
  const like = useMutation(api.reactions.set);
  const [burst, setBurst] = useState(false);
  const doubleTap = () => {
    setBurst(true);
    setTimeout(() => setBurst(false), 700);
    if (!post.reactions.mine) void like({ postId: post.id, kind: "like" });
  };
  return (
    <article className={`post-card ${post.author.kind === "agent" ? "by-agent" : ""}`}>
      <header className="post-head">
        <Byline who={post.author} via={post.via} at={post.createdAt} visibility={post.visibility} edited={post.editedAt !== null} community={post.community} />
        {post.mine && <PostMenu post={post} />}
      </header>
      {post.media.length > 0 && (
        <div className="post-media">
          <Carousel media={post.media} alt={post.text || `Photo by ${post.author.username}`} onDoubleClick={doubleTap} />
          {burst && <span className="burst" aria-hidden>❤️</span>}
        </div>
      )}
      {post.text && (
        <p className={`post-text ${post.media.length ? "" : "big"}`}>
          <RichText text={post.text} />
        </p>
      )}
      <div className="post-actions">
        <Reactions postId={post.id} summary={post.reactions} />
        <Link to={`/p/${post.id}`} className="icon-btn comment-link" aria-label="Comments"><MessageCircle size={19} /> {post.commentCount > 0 && <span>{post.commentCount}</span>}</Link>
      </div>
      {post.comments.length > 0 && (
        <ul className="preview-comments">
          {post.comments.map((c) => (
            <li key={c.id}>
              {c.author && <Name who={c.author} />} <RichText text={c.text} />
            </li>
          ))}
        </ul>
      )}
      {post.commentCount > post.comments.length && <Link to={`/p/${post.id}`} className="muted small view-all">View all {plural(post.commentCount, "comment")}</Link>}
      <QuickComment postId={post.id} />
    </article>
  );
}

function PostMenu({ post }: { post: Card }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const remove = useMutation(api.posts.remove);
  const update = useMutation(api.posts.update);
  const [text, setText] = useState(post.text);
  const [visibility, setVisibility] = useState(post.visibility);
  return (
    <>
      <button className="icon-btn" aria-label="Post options" onClick={() => setOpen(true)}><MoreHorizontal size={20} /></button>
      {open && (
        <Sheet title="Your post" onClose={() => setOpen(false)}>
          <button className="menu-item" onClick={() => (setOpen(false), setEditing(true))}><Pencil size={16} /> Edit</button>
          <button className="menu-item danger" onClick={() => confirm("Delete this post?") && void remove({ id: post.id }).then(() => (setOpen(false), location.pathname.startsWith("/p/") && navigate("/", true)))}><Trash2 size={16} /> Delete</button>
        </Sheet>
      )}
      {editing && (
        <Sheet title="Edit post" onClose={() => setEditing(false)}>
          <form className="stack-form" onSubmit={(e) => (e.preventDefault(), void update({ id: post.id, text, visibility }).then(() => setEditing(false)))}>
            <textarea value={text} maxLength={2200} rows={4} onChange={(e) => setText(e.target.value)} aria-label="Text" />
            <VisibilityPicker value={visibility} onChange={setVisibility} />
            <button className="primary wide">Save</button>
          </form>
        </Sheet>
      )}
    </>
  );
}

export function VisibilityPicker({ value, onChange }: { value: "public" | "followers"; onChange: (v: "public" | "followers") => void }) {
  return (
    <div className="segmented" role="radiogroup" aria-label="Who can see this">
      <button type="button" role="radio" aria-checked={value === "public"} className={value === "public" ? "on" : ""} onClick={() => onChange("public")}><Globe size={14} /> Everyone</button>
      <button type="button" role="radio" aria-checked={value === "followers"} className={value === "followers" ? "on" : ""} onClick={() => onChange("followers")}><Lock size={14} /> Followers</button>
    </div>
  );
}

function QuickComment({ postId }: { postId: string }) {
  const create = useMutation(api.comments.create);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try {
      await create({ postId, text });
      setText("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="quick-comment" onSubmit={submit}>
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a comment… (try @scout)" maxLength={1000} aria-label="Add a comment" />
      {text.trim() && <button className="link-btn" disabled={busy}>Post</button>}
    </form>
  );
}

// ── Conversation ───────────────────────────────────────────────────────────────────────────
type ThreadNode = CommentItem & { children: ThreadNode[] };

/**
 * The conversation, a page of top-level comments at a time (each page live, with its replies).
 * A deep link to a comment on a later page keeps loading pages until it is found.
 */
export function Conversation({ postId, focus }: { postId: string; focus?: string }) {
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [next, setNext] = useState<string | null>(null);
  const [found, setFound] = useState(!focus);
  const [replyTo, setReplyTo] = useState<CommentItem | null>(null);
  const more = () => next && !cursors.includes(next) && setCursors((c) => [...c, next]);
  useEffect(() => {
    if (!found && next) more();
  }, [found, next]);
  return (
    <section className="conversation" aria-label="Conversation">
      {cursors.map((c, i) => (
        <ThreadPage key={c ?? "first"} postId={postId} cursor={c} focus={focus} onReply={setReplyTo}
          onLoaded={(n, hasFocus) => {
            if (hasFocus) setFound(true);
            if (i === cursors.length - 1) setNext(n);
          }} />
      ))}
      {next && found && <button className="secondary small more-comments" onClick={more}>More comments</button>}
      <Composer postId={postId} replyTo={replyTo} onDone={() => setReplyTo(null)} />
    </section>
  );
}

function ThreadPage({ postId, cursor, focus, onReply, onLoaded }: { postId: string; cursor?: string; focus?: string; onReply: (c: CommentItem) => void; onLoaded: (next: string | null, hasFocus: boolean) => void }) {
  const page = useQueryState(api.comments.thread, { postId, limit: 20, ...(cursor ? { cursor } : {}) });
  const tree = useMemo(() => {
    const byId = new Map<string, ThreadNode>();
    for (const c of page.data?.comments ?? []) byId.set(c.id, { ...c, children: [] });
    const roots: ThreadNode[] = [];
    for (const n of byId.values()) (n.parentId && byId.get(n.parentId) ? byId.get(n.parentId)!.children : roots).push(n);
    return roots;
  }, [page.data]);
  const hasFocus = Boolean(focus && page.data?.comments.some((c) => c.id === focus));
  useEffect(() => {
    if (page.data) onLoaded(page.data.nextCursor, hasFocus);
  }, [page.data?.nextCursor, page.data !== undefined, hasFocus]);
  useEffect(() => {
    if (!hasFocus) return;
    const el = document.getElementById(`c-${focus}`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    el?.classList.add("flash");
  }, [hasFocus]);
  if (page.error) return <Failure error={page.error} />;
  if (!page.data) return <Spinner />;
  if (!cursor && tree.length === 0) return <p className="muted center small">No comments yet. Start the conversation, or ask <Link className="token" to="/u/scout">@scout</Link> what it's related to.</p>;
  return <ul className="thread">{tree.map((n) => <CommentNode key={n.id} node={n} depth={0} postId={postId} onReply={onReply} />)}</ul>;
}

function CommentNode({ node, depth, postId, onReply }: { node: ThreadNode; depth: number; postId: string; onReply: (c: CommentItem) => void }) {
  const remove = useMutation(api.comments.remove);
  const update = useMutation(api.comments.update);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(node.text);
  return (
    <li id={`c-${node.id}`} className={`comment ${node.author?.kind === "agent" ? "by-agent" : ""}`}>
      {node.deleted ? (
        <p className="muted small deleted">Comment deleted</p>
      ) : (
        <div className="comment-row">
          <Link to={`/u/${node.author!.username}`}><Avatar user={node.author!} size={30} /></Link>
          <div className="comment-body">
            <div className="bubble">
              <Name who={node.author!} />
              {editing ? (
                <form onSubmit={(e) => (e.preventDefault(), void update({ id: node.id, text }).then(() => setEditing(false)))} className="edit-inline">
                  <input value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} autoFocus aria-label="Edit comment" />
                  <button className="link-btn">Save</button>
                </form>
              ) : (
                <p><RichText text={node.text} /></p>
              )}
            </div>
            <div className="comment-meta small muted">
              <span>{ago(node.createdAt)}{node.editedAt ? " · edited" : ""}</span>
              {node.via && <Via agent={node.via} />}
              <Reactions postId={postId} commentId={node.id} summary={node.reactions} compact />
              <button className="link-btn" onClick={() => onReply(node)}><Reply size={13} /> Reply</button>
              {node.mine && !editing && <button className="link-btn" onClick={() => setEditing(true)}>Edit</button>}
              {node.mine && <button className="link-btn" onClick={() => confirm("Delete this comment?") && void remove({ id: node.id })}>Delete</button>}
            </div>
          </div>
        </div>
      )}
      {node.children.length > 0 && <ul className={`thread nested ${depth >= 3 ? "flat" : ""}`}>{node.children.map((c) => <CommentNode key={c.id} node={c} depth={depth + 1} postId={postId} onReply={onReply} />)}</ul>}
    </li>
  );
}

function Composer({ postId, replyTo, onDone }: { postId: string; replyTo: CommentItem | null; onDone: () => void }) {
  const create = useMutation(api.comments.create);
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (replyTo) input.current?.focus();
  }, [replyTo]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    try {
      await create({ postId, text, ...(replyTo ? { parentId: replyTo.id } : {}) });
      setText("");
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <form className="composer" onSubmit={submit}>
      {replyTo && (
        <div className="replying small">
          Replying to <strong>{replyTo.author?.username}</strong>
          <button type="button" className="icon-btn" aria-label="Cancel reply" onClick={onDone}><X size={14} /></button>
        </div>
      )}
      <div className="composer-row">
        <textarea ref={input} rows={1} value={text} onChange={(e) => setText(e.target.value)} placeholder={replyTo ? "Write a reply…" : "Add to the conversation… @mention people or agents"} maxLength={1000} aria-label="Comment"
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), (e.currentTarget.form as HTMLFormElement).requestSubmit())} />
        <button className="primary small" disabled={!text.trim()}>Post</button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </form>
  );
}

// ── Making a post ──────────────────────────────────────────────────────────────────────────
export type Picked = { file: File; preview: string };

/** Images chosen in the browser, downscaled and uploaded one by one through single-use links. */
export function usePublishing() {
  const client = useFeltKit();
  const uploadLink = useMutation(api.posts.uploadLink);
  return async (picked: Picked[]) => {
    const media = [];
    for (const p of picked) {
      const { blob, width, height } = await prepareImage(p.file);
      const uploaded = await client.uploadFile(await uploadLink(), blob, { name: "photo.jpg", contentType: "image/jpeg" });
      media.push({ fileId: uploaded.id, width, height });
    }
    return media;
  };
}

export function ImagePicker({ picked, onChange }: { picked: Picked[]; onChange: (p: Picked[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const add = (files: FileList | null) => {
    const next = [...picked, ...[...(files ?? [])].slice(0, 10 - picked.length).map((file) => ({ file, preview: URL.createObjectURL(file) }))];
    onChange(next);
  };
  return (
    <div className="picker-grid">
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden onChange={(e) => (add(e.target.files), (e.target.value = ""))} />
      {picked.map((p, i) => (
        <div key={p.preview} className="picked">
          <img src={p.preview} alt={`Selected image ${i + 1}`} />
          <button type="button" className="remove" aria-label={`Remove image ${i + 1}`} onClick={() => onChange(picked.filter((x) => x !== p))}><X size={14} /></button>
        </div>
      ))}
      {picked.length < 10 && (
        <button type="button" className="add-image" onClick={() => input.current?.click()}>
          <ImagePlus size={26} strokeWidth={1.4} />
          <span className="small">{picked.length ? "Add" : "Photos"}</span>
        </button>
      )}
    </div>
  );
}

// ── Grids, states ──────────────────────────────────────────────────────────────────────────
export function Grid({ posts }: { posts: GridPost[] }) {
  return (
    <div className="grid">
      {posts.map((p) => (
        <Link key={p.id} to={`/p/${p.id}`} className="tile" aria-label={p.text || `Post by ${p.author.username}`}>
          {p.cover ? <Photo fileId={p.cover.fileId} alt="" size="grid" /> : <div className="text-tile"><span><RichTextPlain text={p.text} /></span></div>}
          {p.mediaCount > 1 && <span className="multi" aria-hidden>▣</span>}
          {p.author.kind === "agent" && <span className="tile-agent" aria-hidden><AgentGlyph size={11} /></span>}
          <span className="tile-stats"><span>♥ {p.reactionCount}</span><span>💬 {p.commentCount}</span></span>
        </Link>
      ))}
    </div>
  );
}
const RichTextPlain = ({ text }: { text: string }) => <>{text.length > 140 ? `${text.slice(0, 140)}…` : text}</>;

export const Spinner = () => <div className="spinner" role="status" aria-label="Loading" />;

export function Failure({ error }: { error: { message: string } }) {
  return <div className="state"><h3>Something went wrong</h3><p className="muted">{error.message}</p></div>;
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="state empty">
      {icon}
      <h3>{title}</h3>
      {children && <p className="muted">{children}</p>}
    </div>
  );
}
