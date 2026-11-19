/**
 * LinkedOut's screens inside Frame: ask your network, browse people, opportunities, follow-ups,
 * imports, and one person's full record with its evidence. Every statement shown can be expanded to
 * the evidence it rests on (network.explain), so nothing on these screens has to be taken on trust.
 */
import { useState, type FormEvent, type ReactNode } from "react";
import { useAction, useMutation, useQueryState } from "@feltdb/feltkit/react";
import type { ArgsOf, ResultOf } from "@feltdb/feltkit/client";
import { Briefcase, CalendarClock, ChevronDown, ChevronRight, FileUp, MessageSquareText, Route as RouteIcon, Search, Send, Sparkles, Target, X } from "lucide-react";
import { api } from "../feltkit/_generated/api";
import { Empty, Failure, Spinner } from "./components";
import { Link, ago, navigate, plural } from "./lib";

type Card = ResultOf<typeof api.network.search>["people"][number]["person"];
type ReasonT = { factor: string; text: string; evidenceIds: string[] };

const TABS = [
  { key: "", label: "Ask", icon: <Sparkles size={15} /> },
  { key: "people", label: "People", icon: <Search size={15} /> },
  { key: "opportunities", label: "Opportunities", icon: <Briefcase size={15} /> },
  { key: "followups", label: "Follow-ups", icon: <CalendarClock size={15} /> },
  { key: "import", label: "Import", icon: <FileUp size={15} /> },
];

export function Network({ tab }: { tab: string }) {
  return (
    <div className="page network-page">
      <h1 className="page-title"><Briefcase size={22} /> Network</h1>
      <p className="muted small lede">Your professional network, privately yours. Every answer comes from your records and says where each fact came from.</p>
      <nav className="tabs" aria-label="Network">
        {TABS.map((t) => (
          <Link key={t.key} to={`/network${t.key ? `/${t.key}` : ""}`} className={`tab-pill ${tab === t.key ? "active" : ""}`} aria-current={tab === t.key ? "page" : undefined}>{t.icon}{t.label}</Link>
        ))}
      </nav>
      {tab === "" && <><Goal /><Ask /></>}
      {tab === "people" && <People />}
      {tab === "opportunities" && <Opportunities />}
      {tab === "followups" && <Followups />}
      {tab === "import" && <Import />}
    </div>
  );
}

// ------------------------------------------------------------------------------------------- goal

function Goal() {
  const goal = useQueryState(api.intel.goal);
  const set = useMutation(api.intel.setGoal);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [understood, setUnderstood] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  if (goal.data === undefined) return null;
  const save = (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    set({ text }).then((r) => { setUnderstood(r.understood); setEditing(false); }, (err: Error) => setError(err.message));
  };
  if (editing || !goal.data) {
    return (
      <form className="panel goal" onSubmit={save}>
        <label className="field"><span><Target size={14} /> What are you looking for next?</span>
          <input value={text} placeholder="e.g. AI product leadership" minLength={3} maxLength={300} required onChange={(e) => setText(e.target.value)} />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="row"><button className="primary small">Save goal</button>{goal.data && <button type="button" className="link-btn" onClick={() => setEditing(false)}>Cancel</button>}</div>
      </form>
    );
  }
  return (
    <section className="panel goal">
      <div className="panel-head">
        <div>
          <p className="muted tiny">YOUR GOAL</p>
          <strong>{goal.data.text}</strong>
          <div className="chips small-chips">
            {goal.data.functions.map((f) => <span key={f} className="chip">{f}</span>)}
            {goal.data.domains.map((d) => <span key={d} className="chip">{d === "ai" ? "AI" : d}</span>)}
            {goal.data.seniority.length > 0 && <span className="chip">leadership</span>}
            {goal.data.organizations.map((o) => <span key={o.id} className="chip">{o.name}</span>)}
          </div>
          {understood.length > 0 && <p className="muted tiny">Understood as: {understood.join(" · ")}</p>}
        </div>
        <button className="secondary small" onClick={() => { setText(goal.data!.text); setEditing(true); }}>Change</button>
      </div>
    </section>
  );
}

// -------------------------------------------------------------------------------------------- ask

const EXAMPLES = [
  "Find five people in my network who could help me find my next AI product leadership opportunity",
  "Who do I know that's hiring in AI?",
  "Who should I reconnect with?",
  "What changed in my network?",
];

function Ask() {
  const ask = useAction(api.assistant.ask);
  const [q, setQ] = useState("");
  const [asked, setAsked] = useState<ResultOf<typeof api.assistant.ask> | null>(null);
  const [error, setError] = useState<string>();
  const run = (question: string) => {
    setQ(question);
    setError(undefined);
    ask.run({ question }).then((r) => setAsked(r as ResultOf<typeof api.assistant.ask>), (e: Error) => setError(e.message));
  };
  return (
    <section className="ask">
      <form className="ask-box" onSubmit={(e) => { e.preventDefault(); if (q.trim()) run(q.trim()); }}>
        <Sparkles size={18} aria-hidden />
        <input value={q} placeholder="Ask your network…" aria-label="Ask your network" maxLength={500} onChange={(e) => setQ(e.target.value)} />
        <button className="primary small" disabled={ask.running || !q.trim()}>{ask.running ? "…" : "Ask"}</button>
      </form>
      {!asked && !ask.running && (
        <div className="chips examples">{EXAMPLES.map((x) => <button key={x} className="chip" onClick={() => run(x)}>{x}</button>)}</div>
      )}
      {ask.running && <Spinner />}
      {error && <p className="form-error" role="alert">{error}</p>}
      {asked && !ask.running && <Answer r={asked} />}
    </section>
  );
}

function Answer({ r }: { r: ResultOf<typeof api.assistant.ask> }) {
  const result = r.result as Record<string, unknown> & { people?: Array<{ person: Card; reasons?: ReasonT[]; why?: ReasonT[]; limitations?: string[] }>; paths?: Array<{ kind: string; explanation: string; hops: Array<{ personId: string; displayName: string; evidenceIds: string[] }> }> };
  return (
    <article className="panel answer">
      <p className="muted tiny">
        {r.via === "model" && r.model ? <>Routed by {r.model.model} to <code>{r.model.capability}</code> · answer written from your records</> : <>Understood by rules: {r.interpretation.understood.join(" · ")}</>}
      </p>
      {result.people && result.people.length > 0 ? (
        <>
          <p className="answer-lead">{r.answer.split("\n")[0]}</p>
          <ol className="ranked">
            {result.people.map((x) => <PersonResult key={x.person.id} card={x.person} reasons={x.reasons ?? x.why ?? []} limitations={x.limitations} />)}
          </ol>
        </>
      ) : result.paths && result.paths.length > 0 ? (
        <>
          <p className="answer-lead">{r.answer.split("\n")[0]}</p>
          <ul className="paths">{result.paths.map((p, i) => <li key={i}><span className={`pill kind-${p.kind}`}>{p.kind.replace("_", " ")}</span> {p.explanation} <Evidence ids={p.hops.flatMap((h) => h.evidenceIds)} /></li>)}</ul>
        </>
      ) : (
        <pre className="answer-text">{r.answer}</pre>
      )}
      {r.evidenceIds.length > 0 && !result.people && !result.paths && <Evidence ids={r.evidenceIds} label={`${plural(r.evidenceIds.length, "piece")} of evidence`} />}
      {r.limitations.length > 0 && <ul className="limits">{r.limitations.map((l) => <li key={l}>{l}</li>)}</ul>}
    </article>
  );
}

function PersonResult({ card, reasons, limitations }: { card: Card; reasons: ReasonT[]; limitations?: string[] }) {
  return (
    <li className="person-result">
      <div className="pr-head">
        <Initials name={card.displayName} />
        <div>
          <Link to={`/n/${card.id}`} className="strong">{card.displayName}</Link>
          <p className="muted small">{card.current[0] ? `${card.current[0].title} · ${card.current[0].organization}` : "No current position on record"}</p>
        </div>
        <span className={`pill rel-${card.relationship}`}>{card.relationship}</span>
        <span className={`pill strength-${card.strength.level}`} title={card.strength.factors.map((f) => f.text).join("\n") || "Nothing but a connection recorded"}>{card.strength.level}</span>
      </div>
      <ul className="reasons">
        {reasons.map((x, i) => <li key={i}><span className="factor">{x.factor}</span> {x.text} <Evidence ids={x.evidenceIds} /></li>)}
      </ul>
      <p className="muted tiny">How you know them: {card.howKnown.map((h) => `${h.type} via ${h.source.replace(/_/g, " ")}${h.establishedAt ? ` since ${h.establishedAt}` : ""}${h.context ? ` — “${h.context}”` : ""}`).join("; ") || "no established relationship"}</p>
      {limitations && limitations.length > 0 && <p className="muted tiny limit">{limitations.join(" ")}</p>}
    </li>
  );
}

const Initials = ({ name }: { name: string }) => <span className="initials" aria-hidden>{name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase()}</span>;

/** Evidence ids, expandable to what each asserts, its source, date and standing. */
function Evidence({ ids, label }: { ids: string[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const unique = [...new Set(ids)];
  if (!unique.length) return null;
  return (
    <span className="evidence">
      <button className="ev-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}{label ?? `evidence (${unique.length})`}</button>
      {open && <Explained ids={unique} />}
    </span>
  );
}

function Explained({ ids }: { ids: string[] }) {
  const ex = useQueryState(api.network.explain, { evidenceIds: ids.slice(0, 50) });
  if (ex.error) return <Failure error={ex.error} />;
  if (!ex.data) return <Spinner />;
  return <ul className="ev-list">{ex.data.map((e) => <li key={e.id} className={`ev kind-${e.evidence?.kind ?? "none"}`}>{e.statement}{e.evidence?.sourceUri?.startsWith("http") && <> <a href={e.evidence.sourceUri} target="_blank" rel="noreferrer">source</a></>}{e.evidence?.sourceUri?.startsWith("/p/") && <> <Link to={e.evidence.sourceUri}>post</Link></>}</li>)}</ul>;
}

// ----------------------------------------------------------------------------------------- people

const FUNCTIONS = ["product", "engineering", "design", "data", "research", "sales", "marketing", "operations", "finance", "people", "executive"] as const;
const DOMAINS = ["ai", "infrastructure", "data", "fintech", "health", "climate", "security", "devtools", "crypto", "education", "commerce", "media", "saas"] as const;

function People() {
  const [text, setText] = useState("");
  const [organization, setOrganization] = useState("");
  const [fn, setFn] = useState("");
  const [domain, setDomain] = useState("");
  const [leaders, setLeaders] = useState(false);
  const [rel, setRel] = useState<"established" | "any">("established");
  const res = useQueryState(api.network.search, {
    ...(text ? { text } : {}), ...(organization ? { organization } : {}), ...(fn ? { functions: [fn as (typeof FUNCTIONS)[number]] } : {}), ...(domain ? { domains: [domain] } : {}),
    ...(leaders ? { seniority: ["director", "vp", "cxo", "founder"] as const } : {}), relationship: rel, limit: 100,
  } as ArgsOf<typeof api.network.search>);
  const dupes = useQueryState(api.network.duplicates);
  return (
    <section className="people">
      <div className="filters">
        <input value={text} placeholder="Name, title, skill…" aria-label="Search people" onChange={(e) => setText(e.target.value)} />
        <input value={organization} placeholder="Organization" aria-label="Organization" onChange={(e) => setOrganization(e.target.value)} />
        <select value={fn} aria-label="Function" onChange={(e) => setFn(e.target.value)}><option value="">Any function</option>{FUNCTIONS.map((f) => <option key={f}>{f}</option>)}</select>
        <select value={domain} aria-label="Domain" onChange={(e) => setDomain(e.target.value)}><option value="">Any domain</option>{DOMAINS.map((d) => <option key={d} value={d}>{d === "ai" ? "AI" : d}</option>)}</select>
        <label className="check"><input type="checkbox" checked={leaders} onChange={(e) => setLeaders(e.target.checked)} /> Leaders</label>
        <label className="check"><input type="checkbox" checked={rel === "any"} onChange={(e) => setRel(e.target.checked ? "any" : "established")} /> Include people I only know of</label>
      </div>
      {dupes.data && dupes.data.length > 0 && <p className="notice small">{plural(dupes.data.length, "possible duplicate")}: {dupes.data.map((d) => <Link key={d.nameKey} to={`/n/${d.people[0]!.id}`}>{d.people[0]!.displayName}</Link>)}</p>}
      {res.error ? <Failure error={res.error} /> : !res.data ? <Spinner /> : res.data.unknownOrganization ? <p className="muted">No organization named “{res.data.unknownOrganization}” in your network.</p> : res.data.total === 0 ? (
        <Empty icon={<Search />} title="No one matches">Import your connections, or loosen the filters.</Empty>
      ) : (
        <>
          <p className="muted small">{plural(res.data.total, "person", "people")}</p>
          <ul className="people-list">
            {res.data.people.map(({ person: p }) => (
              <li key={p.id}>
                <Link to={`/n/${p.id}`} className="people-row">
                  <Initials name={p.displayName} />
                  <span><strong>{p.displayName}</strong><span className="muted small">{p.current[0] ? `${p.current[0].title} · ${p.current[0].organization}` : p.headline ?? ""}</span></span>
                  <span className={`pill strength-${p.strength.level}`}>{p.strength.level}</span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------- opportunities

function Opportunities() {
  const [stale, setStale] = useState(false);
  const ops = useQueryState(api.intel.opportunities, { includeStale: stale });
  const record = useMutation(api.intel.recordHiring);
  const sync = useMutation(api.intel.syncFrame);
  const [form, setForm] = useState({ organization: "", role: "", sourceUri: "" });
  const [msg, setMsg] = useState<string>();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setMsg(undefined);
    record({ organization: form.organization, role: form.role, ...(form.sourceUri ? { sourceUri: form.sourceUri } : {}) }).then((r) => { setMsg(r.created ? "Recorded." : "Already recorded."); setForm({ organization: "", role: "", sourceUri: "" }); }, (err: Error) => setMsg(err.message));
  };
  return (
    <section className="opportunities">
      <div className="row wrap">
        <button className="secondary small" onClick={() => sync({}).then((r) => setMsg(`From Frame: ${plural(r.added, "new relationship")}, ${plural(r.hiringSignals, "new hiring signal")}${r.ended ? `, ${r.ended} ended` : ""}.`), (e: Error) => setMsg(e.message))}>Sync from Frame</button>
        <label className="check small"><input type="checkbox" checked={stale} onChange={(e) => setStale(e.target.checked)} /> Show stale</label>
      </div>
      {msg && <p className="notice small" role="status">{msg}</p>}
      {!ops.data ? <Spinner /> : ops.data.length === 0 ? <Empty icon={<Briefcase />} title="No hiring signals yet">Record a posting you've seen, or sync hiring posts from people you've linked on Frame.</Empty> : (
        <ul className="ops">
          {ops.data.map((o) => (
            <li key={o.organizationId} className={`panel op ${o.active ? "" : "stale"}`}>
              <div className="panel-head"><div><strong>{o.organization}</strong>{!o.active && <span className="pill">stale</span>}<p className="small">{o.roles.join(" · ")}</p></div></div>
              {o.relevance.length > 0 && <div className="chips small-chips">{o.relevance.map((x) => <span key={x} className="chip accent">{x}</span>)}</div>}
              <p className="muted small">{o.contacts.length ? <>You know {o.contacts.map((c, i) => <span key={c.personId}>{i ? ", " : ""}<Link to={`/n/${c.personId}`}>{c.displayName}</Link></span>)} there.</> : "You know no one there yet."} Seen {ago(o.latestObservedAt)} · valid until {new Date(o.validUntil).toLocaleDateString()}</p>
              <Evidence ids={o.evidence.map((e) => e.id)} />
            </li>
          ))}
        </ul>
      )}
      <form className="panel" onSubmit={submit}>
        <h2 className="section-title">Record a hiring signal</h2>
        <div className="grid2">
          <input required value={form.organization} placeholder="Organization" aria-label="Organization" onChange={(e) => setForm({ ...form, organization: e.target.value })} />
          <input required value={form.role} placeholder="Role" aria-label="Role" onChange={(e) => setForm({ ...form, role: e.target.value })} />
        </div>
        <input type="url" value={form.sourceUri} placeholder="Posting URL (optional, cited as the source)" aria-label="Posting URL" onChange={(e) => setForm({ ...form, sourceUri: e.target.value })} />
        <button className="primary small">Record</button>
      </form>
    </section>
  );
}

// ------------------------------------------------------------------------------------- follow-ups

function Followups() {
  const open = useQueryState(api.followups.listFollowups, {});
  const drafts = useQueryState(api.followups.listDrafts, { status: "draft" });
  const complete = useMutation(api.followups.completeFollowup);
  return (
    <section className="followups">
      <h2 className="section-title">Open follow-ups</h2>
      {!open.data ? <Spinner /> : open.data.length === 0 ? <p className="muted small">Nothing to follow up on.</p> : (
        <ul className="fu-list">
          {open.data.map((f) => (
            <li key={f.id} className={f.overdue ? "overdue" : ""}>
              <div><Link to={`/n/${f.personId}`} className="strong">{f.displayName}</Link> <span className="muted small">{f.overdue ? "overdue · " : ""}{new Date(f.dueAt).toLocaleDateString()}</span><p className="small">{f.reason}</p></div>
              <div className="row"><button className="secondary small" onClick={() => void complete({ followupId: f.id, outcome: "done" })}>Done</button><button className="icon-btn" aria-label="Cancel follow-up" onClick={() => void complete({ followupId: f.id, outcome: "cancelled" })}><X size={16} /></button></div>
            </li>
          ))}
        </ul>
      )}
      <h2 className="section-title">Drafts waiting for you to send</h2>
      {!drafts.data ? <Spinner /> : drafts.data.length === 0 ? <p className="muted small">No drafts.</p> : <ul className="fu-list">{drafts.data.map((d) => <li key={d.id}><div><Link to={`/n/${d.personId}`} className="strong">{d.displayName}</Link> <span className="muted small">{d.purpose} · {ago(d.updatedAt)}</span><p className="small clamp">{d.text}</p></div></li>)}</ul>}
    </section>
  );
}

// ----------------------------------------------------------------------------------------- import

function Import() {
  const imp = useMutation(api.network.importConnections);
  const list = useQueryState(api.network.importsList);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string>();
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setResult(undefined);
    try {
      const r = await imp({ fileName: file.name, csv: await file.text() });
      setResult(r.replayed ? `${file.name} was already imported.` : `${file.name}: ${plural(r.created, "new person", "new people")}, ${r.matched} matched to people you already had${r.skipped.length ? `, ${r.skipped.length} rows skipped` : ""}.`);
    } catch (e) {
      setResult((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="import">
      <div className="panel">
        <h2>Import your connections</h2>
        <p className="muted small">LinkedIn: Settings → Data privacy → Get a copy of your data → Connections. Upload <code>Connections.csv</code> as downloaded. Any CSV with a Name (or First/Last Name) column also works, with optional Email, URL, Company, Position, Connected On, Skills, Industry and Notes. Importing the same file twice changes nothing; people are matched by LinkedIn URL, e-mail, or name at the same company — never by name alone.</p>
        <label className="button primary small file-btn"><FileUp size={14} /> {busy ? "Importing…" : "Choose a CSV file"}<input type="file" accept=".csv,text/csv" hidden disabled={busy} onChange={(e) => void onFile(e.target.files?.[0])} /></label>
        {result && <p className="notice small" role="status">{result}</p>}
      </div>
      <h2 className="section-title">Imports</h2>
      {!list.data ? <Spinner /> : list.data.length === 0 ? <p className="muted small">Nothing imported yet.</p> : <ul className="fu-list">{list.data.map((i) => <li key={i.id}><div><strong>{i.fileName}</strong> <span className="muted small">{i.source.replace("_", " ")} · {ago(i.createdAt)}</span><p className="small">{i.rows} rows · {i.created} new · {i.matched} matched{i.skipped ? ` · ${i.skipped} skipped` : ""}</p></div></li>)}</ul>}
    </section>
  );
}

// ----------------------------------------------------------------------------------------- person

const KIND_LABEL: Record<string, string> = { user_provided: "you said", imported: "imported", observed: "observed", inferred: "inferred", generated: "model-written" };

export function PersonPage({ id }: { id: string }) {
  const rec = useQueryState(api.network.person, { personId: id });
  const brief = useQueryState(api.intel.briefing, { personId: id });
  if (rec.error) return <div className="page"><Failure error={rec.error} /><Link to="/network/people">Back to your network</Link></div>;
  if (!rec.data) return <div className="page"><Spinner /></div>;
  const r = rec.data;
  const p = r.person;
  if (p.id !== id) navigate(`/n/${p.id}`, true);
  return (
    <div className="page person-page">
      <Link to="/network/people" className="muted small">← Network</Link>
      <header className="person-head">
        <Initials name={p.displayName} />
        <div>
          <h1 className="page-title">{p.displayName}</h1>
          <p className="muted">{p.current[0] ? `${p.current[0].title} · ${p.current[0].organization}` : p.headline ?? "No current position on record"}</p>
          <div className="chips small-chips">
            <span className={`pill rel-${p.relationship}`}>{p.relationship}</span>
            <span className={`pill strength-${p.strength.level}`}>strength: {p.strength.level}</span>
            {p.domains.map((d) => <span key={d} className="chip" title="inferred from their record">{d === "ai" ? "AI" : d}</span>)}
            {r.frameProfile && <Link to={`/u/${r.frameProfile.username}`} className="chip">@{r.frameProfile.username} on Frame</Link>}
          </div>
        </div>
      </header>
      {r.possibleDuplicates.length > 0 && <Duplicates keepId={p.id} dupes={r.possibleDuplicates} />}
      <Actions personId={p.id} hasProfile={Boolean(r.frameProfile)} />
      <Paths personId={p.id} />
      <section className="panel">
        <h2 className="section-title">How you know them</h2>
        <ul className="plain">{p.howKnown.map((h, i) => <li key={i}>{h.type} · {h.source.replace(/_/g, " ")}{h.establishedAt ? ` · since ${h.establishedAt}` : ""}{h.closeness ? ` · closeness ${h.closeness}/5` : ""}{h.context ? <> · “{h.context}”</> : null} <Evidence ids={[h.evidenceId]} /></li>)}</ul>
        <p className="small">Strength: <strong>{p.strength.level}</strong>{p.strength.factors.length ? ` — ${p.strength.factors.map((f) => f.text).join("; ")}` : " — nothing recorded beyond the connection"}</p>
        {r.knows.length > 0 && <p className="small">Knows: {r.knows.map((k, i) => <span key={k.id}>{i ? ", " : ""}<Link to={`/n/${k.id}`}>{k.displayName}</Link></span>)}</p>}
      </section>
      <section className="panel">
        <h2 className="section-title">Positions</h2>
        <ul className="plain">{r.positions.map((j) => <li key={j.id} className={j.current ? "" : "muted"}>{j.title || "(no title)"} · {j.organization}{j.startDate ? ` · from ${j.startDate}` : ""}{j.endDate ? ` to ${j.endDate}` : ""}{j.current ? "" : " · ended"} <Evidence ids={[j.evidenceId]} /></li>)}</ul>
      </section>
      {brief.data && (brief.data.suggestions.length > 0 || brief.data.recentPosts.length > 0) && (
        <section className="panel">
          <h2 className="section-title">Before you talk</h2>
          {brief.data.suggestions.length > 0 && <ul className="plain">{brief.data.suggestions.map((x) => <li key={x}>{x}</li>)}</ul>}
          <p className="muted tiny">Suggestions, built from the facts on this page. Not facts themselves.</p>
        </section>
      )}
      <Drafts personId={p.id} />
      {r.interactions.length > 0 && (
        <section className="panel">
          <h2 className="section-title">Interactions</h2>
          <ul className="plain">{r.interactions.map((i) => <li key={i.id}>{i.kind} · {new Date(i.occurredAt).toLocaleDateString()}{i.note ? ` — ${i.note}` : ""}</li>)}</ul>
        </section>
      )}
      <section className="panel">
        <h2 className="section-title">Evidence ({r.evidence.length})</h2>
        <ul className="ev-table">
          {r.evidence.map((e) => <EvidenceRow key={e.id} e={e} />)}
        </ul>
      </section>
      <details className="panel">
        <summary className="section-title">History ({r.history.length})</summary>
        <ol className="plain">{r.history.map((h) => <li key={h.seq} className="small">{new Date(h.at).toLocaleString()} · {h.type.replace(/[._]/g, " ")} · <span className="muted">{h.actorType === "agent" ? "agent " : ""}{h.actor}</span></li>)}</ol>
      </details>
      {r.limitations.length > 0 && <ul className="limits">{r.limitations.map((l) => <li key={l}>{l}</li>)}</ul>}
    </div>
  );
}

function EvidenceRow({ e }: { e: ResultOf<typeof api.network.person>["evidence"][number] }) {
  const dispute = useMutation(api.network.dispute);
  return (
    <li className={`ev kind-${e.kind} ${e.verification}`}>
      <span className="pill">{KIND_LABEL[e.kind] ?? e.kind}</span> <strong>{e.predicate.replace(/_/g, " ")}</strong>: {e.predicate === "frame" ? "linked Frame profile" : e.objectValue}
      <span className="muted tiny"> · {e.sourceType.replace(/_/g, " ")} · {new Date(e.observedAt).toLocaleDateString()}{e.verification !== "unverified" ? ` · ${e.verification.replace("_", " ")}` : ""}</span>
      {e.verification !== "disputed" && e.verification !== "superseded" && <button className="link-btn tiny ev-dispute" onClick={() => { if (confirm("Mark this as wrong? Facts resting on it stop being used; the record is kept.")) void dispute({ evidenceId: e.id }); }}>dispute</button>}
    </li>
  );
}

function Actions({ personId, hasProfile }: { personId: string; hasProfile: boolean }) {
  const record = useMutation(api.network.recordInteraction);
  const follow = useMutation(api.followups.createFollowup);
  const setRel = useMutation(api.network.setRelationship);
  const link = useMutation(api.network.linkProfile);
  const [open, setOpen] = useState<"interaction" | "followup" | "relationship" | "link" | null>(null);
  const [msg, setMsg] = useState<string>();
  const done = (m: string) => () => { setMsg(m); setOpen(null); };
  const fail = (e: Error) => setMsg(e.message);
  let form: ReactNode = null;
  if (open === "interaction") form = <SimpleForm fields={[{ name: "kind", options: ["meeting", "call", "email", "message", "introduction", "other"] }, { name: "note", placeholder: "What happened (optional)" }]} submit={(v) => record({ personId, kind: v.kind as "call", ...(v.note ? { note: v.note } : {}) }).then(done("Interaction recorded."), fail)} />;
  if (open === "followup") form = <SimpleForm fields={[{ name: "due", type: "date" }, { name: "reason", placeholder: "Reason", required: true }]} submit={(v) => follow({ personId, dueAt: Date.parse(v.due || new Date().toISOString().slice(0, 10)), reason: v.reason! }).then(done("Follow-up scheduled; you'll get a notification."), fail)} />;
  if (open === "relationship") form = <SimpleForm fields={[{ name: "type", options: ["direct", "historical"] }, { name: "closeness", options: ["", "1", "2", "3", "4", "5"] }, { name: "context", placeholder: "How you know them, in your words" }]} submit={(v) => setRel({ personId, type: v.type as "direct", ...(v.closeness ? { closeness: Number(v.closeness) } : {}), ...(v.context ? { context: v.context } : {}) }).then(done("Saved as your own account."), fail)} />;
  if (open === "link") form = <SimpleForm fields={[{ name: "username", placeholder: "Their Frame username", required: true }]} submit={(v) => link({ personId, username: v.username! }).then(done("Linked to their Frame profile."), fail)} />;
  return (
    <section className="actions">
      <div className="row wrap">
        <button className="secondary small" onClick={() => setOpen(open === "interaction" ? null : "interaction")}><MessageSquareText size={14} /> Record interaction</button>
        <button className="secondary small" onClick={() => setOpen(open === "followup" ? null : "followup")}><CalendarClock size={14} /> Follow up</button>
        <button className="secondary small" onClick={() => setOpen(open === "relationship" ? null : "relationship")}>How I know them</button>
        {!hasProfile && <button className="secondary small" onClick={() => setOpen(open === "link" ? null : "link")}>Link Frame profile</button>}
      </div>
      {form}
      {msg && <p className="notice small" role="status">{msg}</p>}
    </section>
  );
}

function Paths({ personId }: { personId: string }) {
  const p = useQueryState(api.intel.paths, { personId });
  if (!p.data) return null;
  const indirect = p.data.paths.filter((x) => x.kind !== "direct");
  if (!indirect.length && p.data.paths.length) return null;
  return (
    <section className="panel">
      <h2 className="section-title"><RouteIcon size={14} /> Ways to reach them</h2>
      {indirect.length ? <ul className="paths">{indirect.map((x, i) => <li key={i}><span className={`pill kind-${x.kind}`}>{x.kind.replace("_", " ")}</span> {x.explanation} <Evidence ids={x.hops.flatMap((h) => h.evidenceIds)} /></li>)}</ul> : <p className="muted small">{p.data.limitations[0]}</p>}
    </section>
  );
}

function SimpleForm({ fields, submit }: { fields: Array<{ name: string; placeholder?: string; options?: string[]; type?: string; required?: boolean }>; submit: (v: Record<string, string>) => void }) {
  const [v, setV] = useState<Record<string, string>>(Object.fromEntries(fields.map((f) => [f.name, f.options?.[0] ?? ""])));
  return (
    <form className="panel inline-form" onSubmit={(e) => { e.preventDefault(); submit(v); }}>
      {fields.map((f) => f.options ? (
        <select key={f.name} aria-label={f.name} value={v[f.name]} onChange={(e) => setV({ ...v, [f.name]: e.target.value })}>{f.options.map((o) => <option key={o} value={o}>{o || `${f.name} (optional)`}</option>)}</select>
      ) : (
        <input key={f.name} aria-label={f.name} type={f.type ?? "text"} placeholder={f.placeholder} required={f.required} value={v[f.name]} onChange={(e) => setV({ ...v, [f.name]: e.target.value })} />
      ))}
      <button className="primary small">Save</button>
    </form>
  );
}

function Drafts({ personId }: { personId: string }) {
  const list = useQueryState(api.followups.listDrafts, { personId });
  const draft = useMutation(api.followups.draft);
  const sent = useMutation(api.followups.markSent);
  const discard = useMutation(api.followups.discardDraft);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState<string>();
  return (
    <section className="panel drafts">
      <div className="panel-head">
        <h2 className="section-title">Messages</h2>
        <button className="secondary small" onClick={() => draft({ personId, purpose: "reconnect" }).catch((e: Error) => setError(e.message))}><Send size={14} /> Draft a reconnect note</button>
      </div>
      {error && <p className="form-error">{error}</p>}
      {!list.data ? <Spinner /> : list.data.length === 0 ? <p className="muted small">No drafts. Frame never sends anything: you copy a draft and send it yourself.</p> : (
        <ul className="plain">
          {list.data.map((d) => (
            <li key={d.id} className={`draft ${d.status}`}>
              <p className="muted tiny">{d.purpose} · {d.status === "sent" ? `you sent it ${ago(d.sentAt!)}` : d.status} · written by {d.generatedBy === "template" ? "Frame, from your records" : d.generatedBy === "model" ? `${d.generation?.model}` : "you"}</p>
              <pre className="draft-text">{d.text}</pre>
              {d.basis.length > 0 && <Evidence ids={d.basis} label="built from" />}
              {d.status === "draft" && (
                <div className="row wrap">
                  <button className="secondary small" onClick={() => void navigator.clipboard?.writeText(d.text).then(() => setCopied(d.id))}>{copied === d.id ? "Copied" : "Copy"}</button>
                  <button className="primary small" onClick={() => sent({ draftId: d.id }).catch((e: Error) => setError(e.message))}>I sent it</button>
                  <button className="link-btn small" onClick={() => void discard({ draftId: d.id })}>Discard</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Duplicates({ keepId, dupes }: { keepId: string; dupes: Array<{ id: string; displayName: string; current: string[] }> }) {
  const merge = useMutation(api.network.merge);
  const [error, setError] = useState<string>();
  return (
    <section className="notice">
      <p className="small"><strong>Possible duplicate.</strong> Same name, not merged automatically:</p>
      <ul className="plain">{dupes.map((d) => <li key={d.id} className="small"><Link to={`/n/${d.id}`}>{d.displayName}</Link> {d.current.join(", ")} <button className="link-btn small" onClick={() => { if (confirm(`Merge ${d.displayName} into this record? Their positions, relationships and history move here.`)) merge({ keepId, mergeId: d.id }).catch((e: Error) => setError(e.message)); }}>Merge into this one</button></li>)}</ul>
      {error && <p className="form-error">{error}</p>}
    </section>
  );
}
