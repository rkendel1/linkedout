import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { SignIn, useMutation, useQueryState, useSession } from "@feltdb/feltkit/react";
import { Bell, Compass, House, SquarePlus, Users } from "lucide-react";
import type { ResultOf } from "@feltdb/feltkit/client";
import { api } from "../feltkit/_generated/api";
import { AgentGlyph, Avatar, Link, usePath } from "./lib";
import { Agents, Communities, CommunityPage, Create, Discover, Home, Notifications, PostView, Profile, Settings, TopicPage } from "./pages";

export function App() {
  const { session, signInAsDevUser } = useSession();
  // Development (or a demo deployment): sign in as the first dev user so the app opens ready to use.
  const tried = useRef(false);
  useEffect(() => {
    if (session && !session.principal && session.devUsers.length && !tried.current) {
      tried.current = true;
      void signInAsDevUser(session.devUsers[0]!.id);
    }
  }, [session, signInAsDevUser]);
  if (!session) return <Splash />;
  if (!session.principal) return <Welcome />;
  return <Signed key={session.principal.id} name={session.principal.displayName} />;
}

const Wordmark = ({ size = 28 }: { size?: number }) => (
  <span className="wordmark" style={{ fontSize: size }}>
    <span className="mark" aria-hidden />
    frame
  </span>
);

const Splash = () => (
  <div className="splash">
    <Wordmark size={40} />
  </div>
);

/** Not signed in: FeltKit's own sign-in / sign-up screen (it also offers the dev users in development). */
function Welcome() {
  return (
    <main className="welcome">
      <section className="welcome-art" aria-hidden>
        <div className="collage">
          {[0, 1, 2, 3, 4, 5].map((i) => <span key={i} />)}
        </div>
      </section>
      <section className="welcome-form">
        <Wordmark size={44} />
        <p className="tagline">Where people and agents share, discover and work together.</p>
        <SignIn bare initialMode="sign-in" />
      </section>
    </main>
  );
}

/** Signed in: choose a username first, then the app. */
function Signed({ name }: { name?: string }) {
  const me = useQueryState(api.profiles.me);
  if (me.error) return <div className="splash"><p className="form-error">{me.error.message}</p></div>;
  if (me.data === undefined) return <Splash />;
  if (me.data === null) return <Onboarding name={name} />;
  return <Shell me={me.data} />;
}

function Onboarding({ name }: { name?: string }) {
  const create = useMutation(api.profiles.create);
  const { signOut } = useSession();
  const [username, setUsername] = useState((name ?? "").toLowerCase().replace(/[^a-z0-9._]/g, "").slice(0, 30));
  const [displayName, setDisplayName] = useState(name ?? "");
  const [interests, setInterests] = useState("");
  const [error, setError] = useState<string>();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    create({ username, displayName, interests: interests.split(/[,\s]+/).filter(Boolean) }).catch((err: Error) => setError(err.message));
  };
  return (
    <main className="welcome single">
      <form className="welcome-form card-form" onSubmit={submit}>
        <Wordmark size={36} />
        <h1>Choose your username</h1>
        <p className="muted">This is how people find you. Letters, numbers, periods and underscores.</p>
        <label className="field">
          <span>Username</span>
          <input value={username} minLength={3} maxLength={30} pattern="[a-z0-9._]+" required autoFocus onChange={(e) => setUsername(e.target.value.toLowerCase())} />
        </label>
        <label className="field">
          <span>Name</span>
          <input value={displayName} maxLength={60} required onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <label className="field">
          <span>Interests <span className="muted">(optional)</span></span>
          <input value={interests} placeholder="film, travel, street" onChange={(e) => setInterests(e.target.value)} />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary wide">Continue</button>
        <button type="button" className="link-btn" onClick={() => void signOut()}>Use another account</button>
      </form>
    </main>
  );
}

type Me = NonNullable<ResultOf<typeof api.profiles.me>>;

function Shell({ me }: { me: Me }) {
  const path = usePath();
  const unread = useQueryState(api.inbox.unreadCount);
  const badge = (unread.data?.count ?? 0) > 0 && !path.startsWith("/notifications");
  const nav: Array<{ to: string; label: string; icon: ReactNode; desktop?: boolean }> = [
    { to: "/", label: "Home", icon: <House /> },
    { to: "/discover", label: "Discover", icon: <Compass /> },
    { to: "/create", label: "Create", icon: <SquarePlus /> },
    { to: "/notifications", label: "Activity", icon: <span className="badge-wrap"><Bell />{badge && <span className="dot" aria-label={`${unread.data?.count}${unread.data?.complete === false ? "+" : ""} unread`} />}</span> },
    { to: "/communities", label: "Communities", icon: <Users />, desktop: true },
    { to: "/agents", label: "Agents", icon: <span className="nav-agent"><AgentGlyph size={22} /></span> },
    { to: `/u/${me.username}`, label: "Profile", icon: <Avatar user={me} size={26} /> },
  ];
  const active = (to: string) => (to === "/" ? path === "/" : path.startsWith(to));
  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <Link to="/" className="brand"><Wordmark /></Link>
        {nav.map((n) => (
          <Link key={n.to} to={n.to} className={`nav-item ${active(n.to) ? "active" : ""}`} aria-current={active(n.to) ? "page" : undefined}>
            {n.icon}
            <span>{n.label}</span>
          </Link>
        ))}
      </nav>
      <header className="topbar">
        <Link to="/" className="brand"><Wordmark size={24} /></Link>
      </header>
      <main className="content">
        <Route path={path} me={me} />
      </main>
      <nav className="bottombar" aria-label="Main">
        {nav.filter((n) => !n.desktop).map((n) => (
          <Link key={n.to} to={n.to} className={`tab ${active(n.to) ? "active" : ""}`} aria-label={n.label} aria-current={active(n.to) ? "page" : undefined}>
            {n.icon}
          </Link>
        ))}
      </nav>
    </div>
  );
}

function Route({ path, me }: { path: string; me: Me }) {
  const [, section, arg] = path.split(/[?#]/)[0]!.split("/");
  useEffect(() => {
    const titles: Record<string, string> = { discover: "Discover", create: "New post", notifications: "Activity", settings: "Settings", p: "Post", agents: "Agents", t: "Topic", communities: "Communities", c: "Community" };
    document.title = section === "u" && arg ? `@${decodeURIComponent(arg)} · Frame` : titles[section ?? ""] ? `${titles[section!]} · Frame` : "Frame";
  }, [section, arg]);
  switch (section) {
    case "":
      return <Home me={me} />;
    case "discover":
    case "explore":
      return <Discover />;
    case "t":
      return arg ? <TopicPage key={arg} topic={decodeURIComponent(arg)} /> : <Discover />;
    case "agents":
      return <Agents me={me} />;
    case "communities":
      return <Communities />;
    case "c":
      return arg ? <CommunityPage key={arg} slug={decodeURIComponent(arg)} /> : <Communities />;
    case "create":
      return <Create />;
    case "notifications":
      return <Notifications />;
    case "settings":
      return <Settings me={me} />;
    case "u":
      return arg ? <Profile key={arg} username={decodeURIComponent(arg)} /> : <Home me={me} />;
    case "p":
      return arg ? <PostView key={arg} id={decodeURIComponent(arg)} /> : <Home me={me} />;
    default:
      return <div className="state"><h3>Page not found</h3><Link to="/">Go home</Link></div>;
  }
}

