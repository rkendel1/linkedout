/**
 * The small pieces Frame's screens share: a history router, photo URLs, avatars for people and
 * agents, rich text (@mentions, #topics), image preparation, relative times, infinite scroll.
 */
import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type AnchorHTMLAttributes, type ReactNode } from "react";
import { useFeltKit, useQuery } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";

// ── Routing: plain history API (the FeltKit server falls back to index.html for app paths). ──
const subscribe = (fn: () => void) => (window.addEventListener("popstate", fn), () => window.removeEventListener("popstate", fn));
export const usePath = () => useSyncExternalStore(subscribe, () => location.pathname + location.search + location.hash);
export function navigate(to: string, replace = false) {
  if (to === location.pathname + location.search + location.hash) return;
  history[replace ? "replaceState" : "pushState"](null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
  if (!to.includes("#")) window.scrollTo(0, 0);
}
export function Link({ to, children, ...rest }: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      href={to}
      {...rest}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        rest.onClick?.(e);
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

// ── Photos. posts:mediaLink checks the caller may see the post an image belongs to and returns
// FeltKit's cacheable link: the same URL within its window, cached by the browser. So a live query can
// simply ask again; nothing is re-downloaded. Sizes: "grid" tiles, "feed" cards, "avatar" faces.
export type PhotoSize = "grid" | "feed" | "avatar";
export function usePhotoUrl(fileId: string | undefined, variant?: PhotoSize): string | undefined {
  const client = useFeltKit();
  const link = useQuery(api.posts.mediaLink, fileId ? { fileId, ...(variant ? { variant } : {}) } : "skip");
  return link ? client.fileUrl(link) : undefined;
}

export function Photo({ fileId, alt, className, ratio, onDoubleClick, size = "feed" }: { fileId: string; alt: string; className?: string; ratio?: number; onDoubleClick?: () => void; size?: PhotoSize }) {
  const url = usePhotoUrl(fileId, size);
  const [loaded, setLoaded] = useState(false);
  return (
    <div className={`photo ${loaded ? "loaded" : ""} ${className ?? ""}`} style={ratio ? { aspectRatio: String(ratio) } : undefined} onDoubleClick={onDoubleClick}>
      {url && <img src={url} alt={alt} draggable={false} onLoad={() => setLoaded(true)} />}
    </div>
  );
}

export type Participant = { id?: string; username: string; displayName?: string; avatarFileId?: string | null; kind?: "person" | "agent"; verified?: boolean };

/** People are round; agents are rounded squares with a spark, the same size and weight: different, not lesser. */
export function Avatar({ user, size = 32 }: { user: Participant; size?: number }) {
  const url = usePhotoUrl(user.avatarFileId ?? undefined, "avatar");
  const agent = user.kind === "agent";
  const hue = [...user.username].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return (
    <span className={`avatar ${agent ? "agent" : ""}`} style={{ width: size, height: size, fontSize: size * 0.42, ...(url ? {} : { ["--hue" as string]: hue }) }} aria-hidden>
      {url ? <img src={url} alt="" /> : agent ? <AgentGlyph size={size * 0.52} /> : (user.displayName || user.username).slice(0, 1).toUpperCase()}
      {agent && size >= 28 && <span className="spark" />}
    </span>
  );
}

export function AgentGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 2.5l1.9 5.6 5.6 1.9-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.9L12 2.5z" fill="currentColor" />
      <circle cx="18.5" cy="18.5" r="2.4" fill="currentColor" opacity=".7" />
    </svg>
  );
}

// ── Rich text: @mentions and #topics become links. ──
const TOKEN = /(@[a-z0-9._]{2,29}[a-z0-9_]|#[\p{L}\p{N}_]{2,40}|\bc\/[a-z0-9-]{3,40})/gu;
export function RichText({ text }: { text: string }) {
  const parts = text.split(TOKEN);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <Link key={i} className="token" to={part.startsWith("@") ? `/u/${part.slice(1)}` : part.startsWith("c/") ? `/${part}` : `/t/${part.slice(1).toLowerCase()}`}>
            {part}
          </Link>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

// ── Reactions ──
export const REACTIONS = [
  { kind: "like", emoji: "❤️", label: "Love" },
  { kind: "celebrate", emoji: "🎉", label: "Celebrate" },
  { kind: "insightful", emoji: "💡", label: "Insightful" },
  { kind: "funny", emoji: "😄", label: "Funny" },
  { kind: "wow", emoji: "😮", label: "Wow" },
  { kind: "support", emoji: "🙏", label: "Thanks" },
] as const;
export type ReactionKind = (typeof REACTIONS)[number]["kind"];
export const emoji = (kind: string | null | undefined) => REACTIONS.find((r) => r.kind === kind)?.emoji ?? "";

/** Downscale to at most `max` px on the long side and re-encode as JPEG (strips EXIF, keeps uploads small). */
export async function prepareImage(file: File, max = 1440): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, width, height);
  const blob = await new Promise<Blob>((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error("Could not encode the image."))), "image/jpeg", 0.86));
  return { blob, width, height };
}

const UNITS: Array<[number, string]> = [[60, "s"], [60, "m"], [24, "h"], [7, "d"], [52, "w"]];
export function ago(at: number | string): string {
  let n = Math.max(0, (Date.now() - (typeof at === "string" ? Date.parse(at) : at)) / 1000);
  if (n < 10) return "now";
  for (const [size, unit] of UNITS) {
    if (n < size) return `${Math.floor(n)}${unit}`;
    n /= size;
  }
  return `${Math.floor(n)}y`;
}

/** Calls `onVisible` when the returned element scrolls into view (infinite scroll). */
export function useSentinel(onVisible: () => void, enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onVisible);
  cb.current = onVisible;
  useEffect(() => {
    if (!enabled || !ref.current) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && cb.current(), { rootMargin: "600px" });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [enabled]);
  return ref;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
