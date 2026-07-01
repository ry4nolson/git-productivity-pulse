import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dataset } from './lib/types';
import { clipWeeks, deriveDataset, floorWeek, fmt, fmtFull, markerToUnix, splitByEra, WEEK } from './lib/data';
import {
  collect,
  exchangeOAuthCode,
  getViewer,
  listOrgMembers,
  listOrgs,
  type CollectConfig,
  type CollectProgress,
  type GhOrg,
  type OrgMember,
} from './lib/collector';
import { Leaderboard } from './components/Leaderboard';
import CreatableSelect from 'react-select/creatable';
import type { StylesConfig } from 'react-select';

interface UserOption {
  value: string;
  label: string;
  avatarUrl?: string;
  __isNew__?: boolean;
}

// Tailwind v4 vars hold complete color values — use them directly
const userSelectStyles: StylesConfig<UserOption, false> = {
  control: (base, state) => ({
    ...base,
    backgroundColor: 'var(--color-ink)',
    borderColor: state.isFocused ? 'var(--color-accent)' : 'var(--color-line)',
    borderRadius: 8,
    minHeight: 38,
    boxShadow: 'none',
    ':hover': { borderColor: 'var(--color-accent)' },
  }),
  menu: (base) => ({
    ...base,
    backgroundColor: 'var(--color-panel-2)',
    border: '1px solid var(--color-line)',
    borderRadius: 8,
    overflow: 'hidden',
    zIndex: 30,
  }),
  option: (base, state) => ({
    ...base,
    backgroundColor: state.isFocused ? 'rgba(255,255,255,0.06)' : 'transparent',
    color: 'rgba(255,255,255,0.85)',
    cursor: 'pointer',
    ':active': { backgroundColor: 'rgba(255,255,255,0.1)' },
  }),
  singleValue: (base) => ({ ...base, color: '#fff' }),
  input: (base) => ({ ...base, color: '#fff' }),
  placeholder: (base) => ({ ...base, color: 'rgba(255,255,255,0.25)' }),
  indicatorSeparator: () => ({ display: 'none' }),
  dropdownIndicator: (base) => ({ ...base, color: 'rgba(255,255,255,0.4)', ':hover': { color: '#fff' } }),
  clearIndicator: (base) => ({ ...base, color: 'rgba(255,255,255,0.4)', ':hover': { color: 'var(--color-neg)' } }),
  noOptionsMessage: (base) => ({ ...base, color: 'rgba(255,255,255,0.4)' }),
};

const OAUTH_CLIENT_ID = import.meta.env.VITE_GITHUB_CLIENT_ID as string | undefined;
const OAUTH_PROXY_URL = import.meta.env.VITE_OAUTH_PROXY_URL as string | undefined;
const OAUTH_ENABLED = Boolean(OAUTH_CLIENT_ID && OAUTH_PROXY_URL);
const redirectUri = () => window.location.origin + window.location.pathname;
import { multiple, Pill, Section, Stat } from './components/primitives';
import {
  CommitSizeChart,
  CommitsChart,
  CumulativeChart,
  LinesChart,
  RepoBar,
  REPO_COLORS,
} from './components/Charts';
import { Heatmap } from './components/Heatmap';

const LS_DATA = 'gpp:dataset';
const LS_CFG = 'gpp:config';
const LS_TOKEN = 'gpp:token';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_MARKER = '2023-01-01';

type PresetSpec =
  | 'all'
  | 'thisWeek'
  | 'lastWeek'
  | 'thisMonth'
  | 'lastMonth'
  | { months: number }
  | { trailingDays: number };

// long-horizon presets anchor to the last data week; calendar/trailing ones to today
const PRESETS: ReadonlyArray<readonly [string, PresetSpec]> = [
  ['All', 'all'],
  ['5y', { months: 60 }],
  ['3y', { months: 36 }],
  ['1y', { months: 12 }],
  ['6m', { months: 6 }],
  ['3m', { months: 3 }],
  ['30d', { trailingDays: 30 }],
  ['14d', { trailingDays: 14 }],
  ['7d', { trailingDays: 7 }],
  ['This wk', 'thisWeek'],
  ['Last wk', 'lastWeek'],
  ['This mo', 'thisMonth'],
  ['Last mo', 'lastMonth'],
];

type CompareMode = 'off' | 'prev' | 'yoy';

function urlDateParam(name: string): string | null {
  const v = new URLSearchParams(window.location.search).get(name);
  return v && ISO_DATE.test(v) ? v : null;
}

function ratioOf(post: number, pre: number): number {
  if (!pre) return post ? Infinity : 0;
  return post / pre;
}

function download(href: string, filename: string) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.click();
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  download(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

interface SavedConfig {
  user: string;
  orgs: string;
  users: string;
  since: string;
}

function loadCachedDataset(): Dataset | null {
  try {
    const s = localStorage.getItem(LS_DATA);
    return s ? (JSON.parse(s) as Dataset) : null;
  } catch {
    return null;
  }
}

type Phase = 'setup' | 'running' | 'ready';

export default function App() {
  const [ds, setDs] = useState<Dataset | null>(() => loadCachedDataset());
  const [phase, setPhase] = useState<Phase>(() => (loadCachedDataset() ? 'ready' : 'setup'));
  const [progress, setProgress] = useState<CollectProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [markerDate, setMarkerDate] = useState(() => urlDateParam('marker') ?? DEFAULT_MARKER);
  const [oauthToken, setOauthToken] = useState<string | null>(null);
  const [oauthBusy, setOauthBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // handle the OAuth redirect callback (?code=…)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    if (!code) return;
    const savedState = sessionStorage.getItem('gpp:oauth_state');
    window.history.replaceState({}, '', window.location.pathname);
    if (!OAUTH_ENABLED) return;
    if (state && savedState && state !== savedState) {
      setError('OAuth state mismatch — please try signing in again.');
      return;
    }
    setOauthBusy(true);
    exchangeOAuthCode(OAUTH_PROXY_URL!, code, redirectUri())
      .then((tok) => {
        setOauthToken(tok);
        setPhase('setup');
      })
      .catch((e) => setError(e?.message || String(e)))
      .finally(() => setOauthBusy(false));
  }, []);

  function startOAuth() {
    const state = crypto.randomUUID();
    sessionStorage.setItem('gpp:oauth_state', state);
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', OAUTH_CLIENT_ID!);
    url.searchParams.set('scope', 'repo read:org');
    url.searchParams.set('state', state);
    url.searchParams.set('redirect_uri', redirectUri());
    window.location.href = url.toString();
  }

  async function run(cfg: CollectConfig, remember: boolean) {
    setError(null);
    setProgress(null);
    setPhase('running');
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const data = await collect(cfg, setProgress, ac.signal);
      setDs(data);
      setPhase('ready');
      try {
        localStorage.setItem(LS_DATA, JSON.stringify(data));
      } catch {
        /* dataset too large for localStorage — keep it in memory only */
      }
      const saved: SavedConfig = { user: cfg.user, orgs: cfg.orgs.join(','), users: cfg.users.join(','), since: cfg.since ?? '' };
      localStorage.setItem(LS_CFG, JSON.stringify(saved));
      if (remember) localStorage.setItem(LS_TOKEN, cfg.token);
      else localStorage.removeItem(LS_TOKEN);
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        setPhase(ds ? 'ready' : 'setup');
        return;
      }
      setError(e?.message || String(e));
      setPhase('setup');
    }
  }

  function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    file.text().then((t) => {
      try {
        const parsed = JSON.parse(t) as Dataset;
        setDs(parsed);
        setPhase('ready');
        setError(null);
        try {
          localStorage.setItem(LS_DATA, t);
        } catch {
          /* ignore */
        }
      } catch {
        setError('That file is not valid contributions JSON.');
      }
    });
  }

  if (phase === 'running') {
    return <ProgressView progress={progress} onCancel={() => abortRef.current?.abort()} />;
  }
  if (phase === 'setup' || !ds) {
    return (
      <SetupForm
        onRun={run}
        onUpload={onUpload}
        fileRef={fileRef}
        error={error}
        hasData={!!ds}
        onBack={() => setPhase('ready')}
        oauthEnabled={OAUTH_ENABLED}
        oauthBusy={oauthBusy}
        oauthToken={oauthToken}
        onSignIn={startOAuth}
      />
    );
  }

  return (
    <Dashboard
      ds={ds}
      markerDate={markerDate}
      setMarkerDate={setMarkerDate}
      fileRef={fileRef}
      onUpload={onUpload}
      onReconfigure={() => setPhase('setup')}
    />
  );
}

function Dashboard({
  ds,
  markerDate,
  setMarkerDate,
  fileRef,
  onUpload,
  onReconfigure,
}: {
  ds: Dataset;
  markerDate: string;
  setMarkerDate: (s: string) => void;
  fileRef: React.RefObject<HTMLInputElement>;
  onUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onReconfigure: () => void;
}) {
  const [trim, setTrim] = useState(() => new URLSearchParams(window.location.search).get('trim') !== '0');
  const [compare, setCompare] = useState<CompareMode>(() => {
    const v = new URLSearchParams(window.location.search).get('cmp');
    return v === 'prev' || v === 'yoy' ? v : 'off';
  });
  const fullStart = ds.weeks[0]?.date ?? '2020-01-01';
  const fullEnd = ds.weeks[ds.weeks.length - 1]?.date ?? fullStart;
  const [range, setRange] = useState(() => {
    const from = urlDateParam('from');
    const to = urlDateParam('to');
    const clamp = (v: string) => (v < fullStart ? fullStart : v > fullEnd ? fullEnd : v);
    return { start: from ? clamp(from) : fullStart, end: to ? clamp(to) : fullEnd };
  });

  // reset the range only when a NEW dataset is loaded — comparing identity
  // (not skip-first-render, which StrictMode's double mount defeats) so a
  // range arriving via the URL isn't clobbered
  const prevDs = useRef(ds);
  useEffect(() => {
    if (prevDs.current === ds) return;
    prevDs.current = ds;
    setRange({ start: fullStart, end: fullEnd });
  }, [ds, fullStart, fullEnd]);

  // buckets are keyed by their Sunday start: floor the From date onto its
  // bucket, and w <= To already includes To's bucket (no +WEEK — that pulled
  // in a bucket AFTER the To date)
  const startUnix = floorWeek(markerToUnix(range.start));
  const endUnix = markerToUnix(range.end);
  const view = useMemo(() => deriveDataset(ds, startUnix, endUnix), [ds, startUnix, endUnix]);

  const marker = markerToUnix(markerDate);
  const clip = useMemo(
    () => (trim ? clipWeeks(view.weeks) : { weeks: view.weeks, clipped: 0, threshold: 0 }),
    [view, trim],
  );
  const dsView = useMemo(() => ({ ...view, weeks: clip.weeks }), [view, clip]);
  const era = useMemo(() => splitByEra(view, marker, clip.weeks), [view, marker, clip]);
  const markerDateObj = new Date(marker * 1000);
  const markerYear = markerDateObj.getUTCFullYear();
  const markerWeek = Math.floor((marker - Date.UTC(markerYear, 0, 1) / 1000) / WEEK);
  const isFiltered = range.start !== fullStart || range.end !== fullEnd;

  // keep the view shareable: mirror range/marker/trim into the URL
  useEffect(() => {
    const p = new URLSearchParams();
    if (isFiltered) {
      p.set('from', range.start);
      p.set('to', range.end);
    }
    if (markerDate !== DEFAULT_MARKER) p.set('marker', markerDate);
    if (!trim) p.set('trim', '0');
    if (compare !== 'off') p.set('cmp', compare);
    const qs = p.toString();
    window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
  }, [range.start, range.end, markerDate, trim, isFiltered, compare]);

  // period comparison: same number of week-buckets immediately before the
  // selected range, or the same calendar range shifted back one year
  const curWeekSpan = (floorWeek(endUnix) - startUnix) / WEEK + 1;
  const comparison = useMemo(() => {
    if (compare === 'off') return null;
    let cmpStart: number;
    let cmpEnd: number;
    if (compare === 'prev') {
      cmpStart = startUnix - curWeekSpan * WEEK;
      cmpEnd = startUnix - 1;
    } else {
      const s = new Date(range.start + 'T00:00:00Z');
      s.setUTCFullYear(s.getUTCFullYear() - 1);
      const e = new Date(range.end + 'T00:00:00Z');
      e.setUTCFullYear(e.getUTCFullYear() - 1);
      cmpStart = floorWeek(Math.floor(s.getTime() / 1000));
      cmpEnd = Math.floor(e.getTime() / 1000);
    }
    const cmpView = deriveDataset(ds, cmpStart, cmpEnd);
    const weekSpan = Math.max(1, (floorWeek(cmpEnd) - cmpStart) / WEEK + 1);
    const isoOf = (u: number) => new Date(u * 1000).toISOString().slice(0, 10);
    return {
      view: cmpView,
      weekSpan,
      label: `${isoOf(cmpStart)} → ${isoOf(cmpEnd)}`,
      partial: cmpStart < markerToUnix(fullStart),
    };
  }, [compare, ds, startUnix, endUnix, curWeekSpan, range.start, range.end, fullStart]);

  const rootRef = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);

  function exportCsv() {
    const header = 'week_start,commits,lines_added,lines_deleted,net_lines,churn,avg_commit_size';
    const rows = view.weeks.map((w) =>
      [w.date, w.commits, w.additions, w.deletions, w.net, w.churn, w.avgCommitSize].join(','),
    );
    downloadBlob(
      new Blob([[header, ...rows].join('\n')], { type: 'text/csv' }),
      `${ds.meta.user}-weekly-${range.start}_${range.end}.csv`,
    );
  }

  async function exportPng() {
    if (!rootRef.current || exporting) return;
    setExporting(true);
    try {
      const { toPng } = await import('html-to-image');
      const url = await toPng(rootRef.current, { backgroundColor: '#05060a', pixelRatio: 1.5 });
      download(url, `${ds.meta.user}-pulse.png`);
    } catch (e) {
      console.error('PNG export failed', e);
    } finally {
      setExporting(false);
    }
  }

  function preset(spec: PresetSpec) {
    if (spec === 'all') return setRange({ start: fullStart, end: fullEnd });
    const clamp = (v: string) => (v < fullStart ? fullStart : v > fullEnd ? fullEnd : v);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const set = (s: Date, e: Date) => setRange({ start: clamp(iso(s)), end: clamp(iso(e)) });
    const today = new Date();

    if (typeof spec === 'object' && 'months' in spec) {
      const end = new Date(fullEnd + 'T00:00:00Z');
      const start = new Date(end);
      start.setUTCMonth(start.getUTCMonth() - spec.months);
      return set(start, end);
    }
    if (typeof spec === 'object') {
      const start = new Date(today);
      start.setUTCDate(start.getUTCDate() - (spec.trailingDays - 1));
      return set(start, today);
    }
    const sunday = new Date(today);
    sunday.setUTCDate(sunday.getUTCDate() - sunday.getUTCDay());
    switch (spec) {
      case 'thisWeek':
        return set(sunday, today);
      case 'lastWeek': {
        const s = new Date(sunday);
        s.setUTCDate(s.getUTCDate() - 7);
        const e = new Date(sunday);
        e.setUTCDate(e.getUTCDate() - 1);
        return set(s, e);
      }
      case 'thisMonth':
        return set(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)), today);
      case 'lastMonth':
        return set(
          new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1)),
          new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0)),
        );
    }
  }

  const topLang = view.languages[0];
  const peakWeek = useMemo(
    () => view.weeks.reduce((a, b) => (b.commits > a.commits ? b : a), view.weeks[0] ?? { commits: 0, date: '' }),
    [view],
  );

  return (
    <div ref={rootRef} className="mx-auto max-w-[1200px] px-4 pb-20 pt-8 sm:px-6">
      {/* header */}
      <header className="mb-8 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-accent">
            <span className="glow text-xl">⚡</span> Git Productivity Pulse
          </div>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-white sm:text-4xl">
            {ds.meta.user}
            <span className="text-white/30"> · weekly output</span>
          </h1>
          <p className="mt-1 text-sm text-white/45">
            {view.meta.reposContributed} repos · {ds.meta.orgs.join(', ') || ds.meta.users.join(', ')} ·{' '}
            {view.weeks[0]?.date ?? range.start} → {view.weeks[view.weeks.length - 1]?.date ?? range.end}
            {isFiltered && <span className="ml-2 text-accent">· filtered</span>}
          </p>
        </div>
        <div className="flex items-center gap-2 self-start sm:self-end">
          <button
            onClick={onReconfigure}
            className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-accent transition hover:border-accent hover:bg-accent/20"
          >
            ⚙ New analysis
          </button>
          <button
            onClick={exportCsv}
            title="Download the filtered weekly data as CSV"
            className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm text-white/70 transition hover:border-accent hover:text-white"
          >
            ↓ CSV
          </button>
          <button
            onClick={exportPng}
            disabled={exporting}
            title="Download the whole dashboard as a PNG image"
            className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm text-white/70 transition hover:border-accent hover:text-white disabled:opacity-50"
          >
            {exporting ? 'Rendering…' : '↓ PNG'}
          </button>
          <button
            onClick={() => fileRef.current?.click()}
            className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm text-white/70 transition hover:border-accent hover:text-white"
          >
            Load JSON
          </button>
          <button
            onClick={() => {
              [LS_TOKEN, LS_DATA, LS_CFG, 'gpp:statscache', 'gpp:statscache2'].forEach((k) => localStorage.removeItem(k));
              sessionStorage.removeItem('gpp:oauth_state');
              window.location.reload();
            }}
            className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm text-white/50 transition hover:border-neg hover:text-neg"
          >
            Sign out
          </button>
        </div>
        <input ref={fileRef} type="file" accept="application/json" className="hidden" onChange={onUpload} />
      </header>

      {/* control bar */}
      <div className="card rise mb-6 flex flex-col gap-4 p-4 sm:flex-row sm:flex-wrap sm:items-end sm:gap-6">
        <div className="flex items-end gap-3">
          <label className="flex flex-col text-xs text-white/40">
            From
            <input
              type="date"
              value={range.start}
              min={fullStart}
              max={range.end}
              onChange={(e) => setRange((r) => ({ ...r, start: e.target.value }))}
              className="mt-1 rounded-lg border border-line bg-panel-2 px-3 py-1.5 text-sm text-white outline-none focus:border-accent"
            />
          </label>
          <label className="flex flex-col text-xs text-white/40">
            To
            <input
              type="date"
              value={range.end}
              min={range.start}
              max={fullEnd}
              onChange={(e) => setRange((r) => ({ ...r, end: e.target.value }))}
              className="mt-1 rounded-lg border border-line bg-panel-2 px-3 py-1.5 text-sm text-white outline-none focus:border-accent"
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {PRESETS.map(([lbl, m]) => (
            <button
              key={lbl}
              onClick={() => preset(m)}
              className="rounded-full border border-line bg-panel-2 px-3 py-1 text-xs text-white/60 transition hover:border-accent hover:text-white"
            >
              {lbl}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-4 sm:ml-auto">
          <label className="flex flex-col text-xs text-white/40">
            Compare
            <select
              value={compare}
              onChange={(e) => setCompare(e.target.value as CompareMode)}
              className="mt-1 rounded-lg border border-line bg-panel-2 px-3 py-[7px] text-sm text-white outline-none focus:border-accent"
            >
              <option value="off">Off</option>
              <option value="prev">vs previous period</option>
              <option value="yoy">vs same period last year</option>
            </select>
          </label>
          <label className="flex flex-col text-xs text-white/40">
            AI marker
            <input
              type="date"
              value={markerDate}
              onChange={(e) => setMarkerDate(e.target.value)}
              className="mt-1 rounded-lg border border-line bg-panel-2 px-3 py-1.5 text-sm text-white outline-none focus:border-amber"
            />
          </label>
          <label className="flex cursor-pointer flex-col text-xs text-white/40">
            Trim bulk commits
            <button
              onClick={() => setTrim((t) => !t)}
              className={`mt-1 rounded-lg border px-3 py-1.5 text-sm transition ${
                trim ? 'border-accent/50 bg-accent/10 text-accent' : 'border-line bg-panel-2 text-white/60'
              }`}
              title="Winsorize lockfile/vendor/generated-code weeks at the 98th percentile so LOC trends stay legible"
            >
              {trim ? `on · ${clip.clipped} wks` : 'off'}
            </button>
          </label>
        </div>
      </div>

      {/* period comparison */}
      {comparison && (
        <div className="mb-6">
          <Section
            title="Comparison"
            subtitle={`${range.start} → ${range.end} vs ${comparison.label} (${compare === 'prev' ? 'previous period' : 'same period last year'})`}
          >
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <MiniDelta
                label="Commits"
                pre={comparison.view.totals.commits}
                post={view.totals.commits}
                ratio={ratioOf(view.totals.commits, comparison.view.totals.commits)}
                format={fmt}
              />
              <MiniDelta
                label="Lines changed"
                pre={comparison.view.totals.churn}
                post={view.totals.churn}
                ratio={ratioOf(view.totals.churn, comparison.view.totals.churn)}
                format={fmt}
              />
              <MiniDelta
                label="Commits / wk"
                pre={comparison.view.totals.commits / comparison.weekSpan}
                post={view.totals.commits / curWeekSpan}
                ratio={ratioOf(view.totals.commits / curWeekSpan, comparison.view.totals.commits / comparison.weekSpan)}
                digits={1}
              />
              <MiniDelta
                label="Active weeks"
                pre={comparison.view.totals.weeksActive}
                post={view.totals.weeksActive}
                ratio={ratioOf(view.totals.weeksActive, comparison.view.totals.weeksActive)}
              />
            </div>
            {comparison.partial && (
              <p className="mt-3 text-xs text-amber/80">
                ⚠ The comparison period starts before the collected data ({fullStart}), so its numbers may be
                understated.
              </p>
            )}
          </Section>
        </div>
      )}

      {/* the headline: AI-era impact */}
      <div className="card rise relative mb-6 overflow-hidden p-6 sm:p-8">
        <div className="pointer-events-none absolute -right-20 -top-24 h-64 w-64 rounded-full bg-accent-2/20 blur-3xl" />
        <div className="pointer-events-none absolute -left-24 bottom-0 h-56 w-56 rounded-full bg-accent/10 blur-3xl" />
        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-widest text-amber">
              Since AI adoption ({markerDate})
            </div>
            {era.pre.weeks > 0 && era.post.weeks > 0 ? (
              <>
                <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="tnum text-5xl font-bold tracking-tight text-white sm:text-6xl">
                    {multiple(era.delta.commitsPerWeek)}
                  </span>
                  <span className="text-lg text-white/60">commits / week</span>
                </div>
                <p className="mt-2 max-w-md text-sm text-white/50">
                  {era.post.commitsPerWeek.toFixed(1)} commits/week in the AI era vs{' '}
                  {era.pre.commitsPerWeek.toFixed(1)} before — and {multiple(era.delta.churnPerWeek)} the lines
                  of code per week.
                </p>
              </>
            ) : (
              <>
                <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="tnum text-5xl font-bold tracking-tight text-white sm:text-6xl">
                    {(era.pre.weeks > 0 ? era.pre.commitsPerWeek : era.post.commitsPerWeek).toFixed(1)}
                  </span>
                  <span className="text-lg text-white/60">commits / week</span>
                </div>
                <p className="mt-2 max-w-md text-sm text-white/50">
                  The {markerDate} marker is outside the selected date range, so there's no before/after to
                  compare. Widen the range to span the marker to see the AI-era multiplier.
                </p>
              </>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
            <MiniDelta label="Commits / wk" pre={era.pre.commitsPerWeek} post={era.post.commitsPerWeek} ratio={era.delta.commitsPerWeek} digits={1} />
            <MiniDelta label="LOC / wk" pre={era.pre.churnPerWeek} post={era.post.churnPerWeek} ratio={era.delta.churnPerWeek} />
            <MiniDelta label="Active wks" pre={era.pre.activeRate * 100} post={era.post.activeRate * 100} suffix="%" digits={0} ratio={era.post.activeRate / (era.pre.activeRate || 1)} />
            <MiniDelta label="LOC / commit" pre={era.pre.avgCommitSize} post={era.post.avgCommitSize} digits={0} ratio={era.post.avgCommitSize / (era.pre.avgCommitSize || 1)} />
          </div>
        </div>
      </div>

      {/* lifetime KPIs */}
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Total commits" value={fmt(view.totals.commits)} sub={`${view.totals.weeksActive} active weeks`} accent="accent" big />
        <Stat label="Lines added" value={fmt(view.totals.additions)} sub={`+${fmtFull(view.totals.additions)}`} accent="pos" big />
        <Stat label="Lines deleted" value={fmt(view.totals.deletions)} sub={`-${fmtFull(view.totals.deletions)}`} accent="neg" big />
        <Stat label="Net LOC" value={fmt(view.totals.net)} sub={`${fmt(view.totals.churn)} total churn`} accent="accent-2" big />
      </div>
      <p className="-mt-2 mb-6 text-xs text-white/35">
        LOC totals come from GitHub's per-author weekly stats and include committed lockfiles, vendored
        deps and generated bundles, so they read high. <span className="text-white/55">Commits</span> are the
        cleaner productivity signal; the <span className="text-accent/80">Trim bulk commits</span> toggle
        winsorizes outlier weeks in the LOC charts below.
      </p>

      {/* commits over time */}
      <div className="mb-6">
        <Section title="Commits per week" subtitle="Weekly commit volume with an 8-week rolling trend. Dashed line marks AI adoption.">
          <CommitsChart ds={view} marker={marker} />
        </Section>
      </div>

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <Section title="Lines added vs deleted" subtitle="Code written (up) and removed (down) each week.">
          <LinesChart ds={dsView} marker={marker} />
        </Section>
        <Section title="Cumulative net lines" subtitle="Running total of net lines of code committed.">
          <CumulativeChart ds={dsView} marker={marker} />
        </Section>
      </div>

      <div className="mb-6">
        <Section
          title="Commit size over time"
          subtitle="Average lines of code per commit. Smaller, steadier commits often signal a tighter AI-assisted loop."
        >
          <CommitSizeChart ds={dsView} marker={marker} />
        </Section>
      </div>

      {/* heatmap */}
      <div className="mb-6">
        <Section title="Activity heatmap" subtitle="Commits per week, by calendar year. Amber ring marks the AI adoption week.">
          <Heatmap weeks={view.weeks} markerYear={markerYear} markerWeek={markerWeek} />
        </Section>
      </div>

      {/* repos + languages */}
      <div className="mb-6 grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Section title="Top repositories" subtitle="Where the commits landed.">
            <RepoBar ds={view} />
          </Section>
        </div>
        <div className="lg:col-span-2">
          <Section title="Languages" subtitle="By lines added.">
            <LanguageList ds={view} />
          </Section>
        </div>
      </div>

      {/* leaderboard */}
      {ds.authors && ds.authors.length > 1 && (
        <div className="mb-6">
          <Section
            title="Leaderboard"
            subtitle="Every contributor across the scanned repos, in the selected date range. Monthly commits for the top 6."
          >
            <Leaderboard authors={ds.authors} startUnix={startUnix} endUnix={endUnix} highlight={ds.meta.user} />
          </Section>
        </div>
      )}

      {/* fun facts */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat label="Busiest week" value={`${peakWeek?.commits ?? 0}`} sub={`commits · week of ${peakWeek?.date}`} accent="amber" />
        <Stat label="Top language" value={topLang?.language ?? '—'} sub={topLang ? `+${fmt(topLang.additions)} lines` : ''} accent="accent" />
        <Stat label="Repos touched" value={`${view.meta.reposContributed}`} sub={isFiltered ? 'in range' : `of ${ds.meta.reposScanned} scanned`} accent="accent-2" />
      </div>

      {ds.meta.skipped && ds.meta.skipped.length > 0 && (
        <div className="card mb-6 border-amber/30 bg-amber/5 p-3 text-xs text-amber/90">
          ⏳ {ds.meta.skipped.length} repo{ds.meta.skipped.length > 1 ? 's were' : ' was'} skipped — GitHub was
          still computing their stats (usual for repos pushed in the last minute):{' '}
          <span className="text-amber/70">{ds.meta.skipped.join(', ')}</span>. Run a new analysis in a minute to
          include {ds.meta.skipped.length > 1 ? 'them' : 'it'}.
        </div>
      )}

      <footer className="mt-10 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-6 text-xs text-white/35">
        <span>
          Generated {new Date(ds.meta.generatedAt).toLocaleString()} · scanned {ds.meta.reposScanned} repos in{' '}
          {ds.meta.collectorSeconds}s
        </span>
        <span>Git Productivity Pulse · data via GitHub /stats/contributors</span>
      </footer>
    </div>
  );
}

function MiniDelta({
  label,
  pre,
  post,
  ratio,
  suffix = '',
  digits = 0,
  format,
}: {
  label: string;
  pre: number;
  post: number;
  ratio: number;
  suffix?: string;
  digits?: number;
  format?: (n: number) => string;
}) {
  const up = post >= pre;
  const show = (n: number) => (format ? format(n) : n.toFixed(digits));
  return (
    <div className="rounded-xl border border-line bg-panel-2/60 p-3">
      <div className="text-[10px] font-medium uppercase tracking-wider text-white/40">{label}</div>
      <div className="tnum mt-1 text-xl font-bold text-white">
        {show(post)}
        {suffix}
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        <Pill tone={up ? 'up' : 'down'}>
          {up ? '▲' : '▼'} {multiple(ratio)}
        </Pill>
        <span className="tnum text-[11px] text-white/35">
          from {show(pre)}
          {suffix}
        </span>
      </div>
    </div>
  );
}

function LanguageList({ ds }: { ds: Dataset }) {
  const langs = ds.languages.filter((l) => l.additions > 0).slice(0, 9);
  const max = Math.max(1, ...langs.map((l) => l.additions));
  return (
    <div className="flex flex-col gap-2.5">
      {langs.map((l, i) => (
        <div key={l.language} className="flex items-center gap-3">
          <div className="w-24 truncate text-sm text-white/70">{l.language}</div>
          <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-white/5">
            <div
              className="h-full rounded-full"
              style={{ width: `${(l.additions / max) * 100}%`, background: REPO_COLORS[i % REPO_COLORS.length] }}
            />
          </div>
          <div className="tnum w-14 text-right text-xs text-white/50">{fmt(l.additions)}</div>
        </div>
      ))}
      {langs.length === 0 && <p className="text-sm text-white/40">No language data.</p>}
    </div>
  );
}

function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const inputCls =
  'mt-1 w-full rounded-lg border border-line bg-ink px-3 py-2 text-sm text-white outline-none placeholder:text-white/25 focus:border-accent';

interface ScopeItem {
  id: string;
  label: string;
  avatarUrl: string;
  hint?: string;
}

function ScopeMultiSelect({
  items,
  selected,
  onToggle,
  onAdd,
}: {
  items: ScopeItem[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onAdd: (login: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const filtered = items.filter((o) => o.label.toLowerCase().includes(q.trim().toLowerCase()));
  const canAdd = q.trim() && !items.some((o) => o.label.toLowerCase() === q.trim().toLowerCase());
  const labelFor = (id: string) => items.find((o) => o.id === id)?.label ?? id;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between rounded-lg border border-line bg-ink px-3 py-2 text-sm text-white outline-none focus:border-accent"
      >
        <span className={selected.size ? 'text-white' : 'text-white/30'}>
          {selected.size ? `${selected.size} selected` : 'Select organizations / accounts…'}
        </span>
        <span className="text-white/40">▾</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-line bg-panel-2 p-1.5 shadow-2xl">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter or add an org…"
              className="mb-1 w-full rounded-md border border-line bg-ink px-2.5 py-1.5 text-sm text-white outline-none placeholder:text-white/25 focus:border-accent"
            />
            {filtered.map((o) => (
              <label key={o.id} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-white/80 hover:bg-white/5">
                <input type="checkbox" checked={selected.has(o.id)} onChange={() => onToggle(o.id)} className="accent-[var(--color-accent)]" />
                {o.avatarUrl ? (
                  <img src={o.avatarUrl} alt="" className="h-5 w-5 rounded" />
                ) : (
                  <span className="grid h-5 w-5 place-items-center rounded bg-white/10 text-[10px]">{o.label[0]?.toUpperCase()}</span>
                )}
                <span className="truncate">{o.label}</span>
                {o.hint && <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-white/30">{o.hint}</span>}
              </label>
            ))}
            {canAdd && (
              <button
                type="button"
                onClick={() => {
                  onAdd(q.trim());
                  setQ('');
                }}
                className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-sm text-accent hover:bg-accent/10"
              >
                + Add “{q.trim()}”
              </button>
            )}
            {filtered.length === 0 && !canAdd && <p className="px-2 py-2 text-sm text-white/40">No matches.</p>}
          </div>
        </>
      )}

      {selected.size > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {[...selected].map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => onToggle(id)}
              className="inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-2.5 py-0.5 text-xs text-accent hover:bg-accent/20"
            >
              {labelFor(id)} <span className="text-accent/60">✕</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SetupForm({
  onRun,
  onUpload,
  fileRef,
  error,
  hasData,
  onBack,
  oauthEnabled,
  oauthBusy,
  oauthToken,
  onSignIn,
}: {
  onRun: (cfg: CollectConfig, remember: boolean) => void;
  onUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  fileRef: React.RefObject<HTMLInputElement>;
  error: string | null;
  hasData: boolean;
  onBack: () => void;
  oauthEnabled: boolean;
  oauthBusy: boolean;
  oauthToken: string | null;
  onSignIn: () => void;
}) {
  const saved: SavedConfig = (() => {
    try {
      return JSON.parse(localStorage.getItem(LS_CFG) || '{}');
    } catch {
      return {} as SavedConfig;
    }
  })();
  const savedOrgs = (saved.orgs || '').split(',').map((s) => s.trim()).filter(Boolean);
  const hasSaved = !!(localStorage.getItem(LS_TOKEN) || localStorage.getItem(LS_DATA) || localStorage.getItem(LS_CFG));

  const [token, setToken] = useState(() => oauthToken || localStorage.getItem(LS_TOKEN) || '');
  const [remember, setRemember] = useState(!!localStorage.getItem(LS_TOKEN));
  const [since, setSince] = useState(saved.since || '2021-01-01');
  const [measureUser, setMeasureUser] = useState(saved.user || '');

  const savedUsers = (saved.users || '').split(',').map((s) => s.trim()).filter(Boolean);
  const [connecting, setConnecting] = useState(false);
  const [connectErr, setConnectErr] = useState<string | null>(null);
  const [viewer, setViewer] = useState<string | null>(null);
  const [viewerAvatar, setViewerAvatar] = useState('');
  const [orgs, setOrgs] = useState<GhOrg[]>([]);
  // selection ids are prefixed: org:<login> for orgs, user:<login> for accounts
  const [selected, setSelected] = useState<Set<string>>(
    new Set([...savedOrgs.map((o) => `org:${o}`), ...savedUsers.map((u) => `user:${u}`)]),
  );
  const [showToken, setShowToken] = useState(!oauthEnabled);
  const [refresh, setRefresh] = useState(false);
  const [members, setMembers] = useState<OrgMember[]>([]);

  async function connect(tok: string) {
    const t = tok.trim();
    if (!t) return;
    setConnecting(true);
    setConnectErr(null);
    try {
      const [me, myOrgs] = await Promise.all([getViewer(t), listOrgs(t)]);
      setViewer(me.login);
      setViewerAvatar(me.avatarUrl);
      setMeasureUser((u) => u || me.login);
      // ensure any previously-used orgs that aren't in the membership list still appear
      const extra = savedOrgs
        .filter((o) => !myOrgs.some((m) => m.login === o))
        .map((login) => ({ login, avatarUrl: '' }));
      setOrgs([...myOrgs, ...extra]);
    } catch (e: any) {
      setConnectErr(e?.message || String(e));
      setViewer(null);
    } finally {
      setConnecting(false);
    }
  }

  // auto-connect on mount (cached token) and whenever an OAuth token arrives
  useEffect(() => {
    if (oauthToken) {
      setToken(oauthToken);
      setRemember(true);
      connect(oauthToken);
    } else if (token) {
      connect(token);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oauthToken]);

  // load members of the selected orgs so "username to measure" is a picker
  useEffect(() => {
    if (!viewer || !token.trim()) return;
    const orgLogins = [...selected].filter((s) => s.startsWith('org:')).map((s) => s.slice(4));
    if (orgLogins.length === 0) {
      setMembers([]);
      return;
    }
    let stale = false;
    Promise.all(orgLogins.map((o) => listOrgMembers(o, token.trim()))).then((lists) => {
      if (stale) return;
      const seen = new Set<string>();
      setMembers(
        lists
          .flat()
          .filter((m) => !seen.has(m.login) && seen.add(m.login))
          .sort((a, b) => a.login.localeCompare(b.login)),
      );
    });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, viewer]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function addOrg(login: string) {
    setOrgs((prev) => (prev.some((o) => o.login === login) ? prev : [...prev, { login, avatarUrl: '' }]));
    setSelected((prev) => new Set(prev).add(`org:${login}`));
  }

  const scopeItems: ScopeItem[] = [
    ...(viewer ? [{ id: `user:${viewer}`, label: viewer, avatarUrl: viewerAvatar, hint: 'you' }] : []),
    ...orgs.map((o) => ({ id: `org:${o.login}`, label: o.login, avatarUrl: o.avatarUrl })),
  ];

  const valid = viewer && measureUser.trim() && selected.size > 0;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    const ids = [...selected];
    onRun(
      {
        user: measureUser.trim(),
        orgs: ids.filter((s) => s.startsWith('org:')).map((s) => s.slice(4)),
        users: ids.filter((s) => s.startsWith('user:')).map((s) => s.slice(5)),
        since: since || undefined,
        token: token.trim(),
        refresh,
      },
      remember,
    );
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-5 py-10">
      <div className="mb-6 text-center">
        <div className="glow text-4xl">⚡</div>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-white">Git Productivity Pulse</h1>
        <p className="mt-1 text-sm text-white/45">
          Visualize anyone's weekly GitHub output. Runs entirely in your browser against the GitHub API.
        </p>
      </div>

      {(error || connectErr) && (
        <div className="card mb-4 border-neg/40 bg-neg/5 p-3 text-sm text-neg">{error || connectErr}</div>
      )}

      <form onSubmit={submit} className="card rise flex flex-col gap-4 p-5 sm:p-6">
        {oauthEnabled && (
          <>
            <button
              type="button"
              onClick={onSignIn}
              disabled={oauthBusy}
              className="flex items-center justify-center gap-2 rounded-lg bg-white px-4 py-3 text-sm font-semibold text-black transition hover:brightness-90 disabled:opacity-50"
            >
              <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
              </svg>
              {oauthBusy ? 'Signing in…' : viewer ? `Signed in as ${viewer}` : 'Sign in with GitHub'}
            </button>
            <p className="-mt-1 text-center text-[11px] text-white/30">
              Authorize once — no token to create or paste.
            </p>
            {!showToken && !viewer && (
              <button type="button" onClick={() => setShowToken(true)} className="text-center text-[11px] text-white/35 hover:text-white">
                Advanced: use a personal access token instead
              </button>
            )}
          </>
        )}

        {/* token + connect (primary when OAuth isn't configured, otherwise opt-in) */}
        {(showToken || !oauthEnabled) && (
          <div>
            {oauthEnabled && (
              <div className="mb-3 flex items-center gap-3 text-[11px] uppercase tracking-wider text-white/25">
                <span className="h-px flex-1 bg-line" /> personal access token <span className="h-px flex-1 bg-line" />
              </div>
            )}
            <label className="text-xs font-medium uppercase tracking-wider text-white/45">Personal access token</label>
            <div className="mt-1 flex gap-2">
              <input
                type="password"
                className="w-full rounded-lg border border-line bg-ink px-3 py-2 text-sm text-white outline-none placeholder:text-white/25 focus:border-accent"
                value={token}
                onChange={(e) => {
                  setToken(e.target.value);
                  setViewer(null);
                }}
                onBlur={() => !viewer && token.trim() && connect(token)}
                placeholder="ghp_…"
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => connect(token)}
                disabled={!token.trim() || connecting}
                className="shrink-0 rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm text-white/80 transition hover:border-accent disabled:opacity-40"
              >
                {connecting ? 'Connecting…' : viewer ? 'Reconnect' : 'Connect'}
              </button>
            </div>
            <div className="mt-1.5 flex items-center justify-between text-[11px] text-white/40">
              {viewer ? (
                <span className="text-pos">✓ Connected as {viewer}</span>
              ) : (
                <span>Needs scopes repo + read:org</span>
              )}
              <a href="https://github.com/settings/tokens/new?scopes=repo,read:org&description=Git%20Productivity%20Pulse" target="_blank" rel="noreferrer" className="text-accent hover:underline">
                Create a token ↗
              </a>
            </div>
          </div>
        )}

        {/* connected: configure */}
        {viewer && (
          <>
            <div className="text-xs font-medium uppercase tracking-wider text-white/45">
              Organizations &amp; accounts to scan
              <div className="mt-1 font-sans normal-case">
                <ScopeMultiSelect items={scopeItems} selected={selected} onToggle={toggle} onAdd={addOrg} />
              </div>
              <p className="mt-1.5 font-sans text-[11px] normal-case text-white/30">
                Tick your own account (<span className="text-white/50">@{viewer}</span>) to include your personal repos.
              </p>
            </div>

            <div className="text-xs font-medium uppercase tracking-wider text-white/45">
              Username to measure
              <div className="mt-1 font-sans text-sm normal-case tracking-normal">
                <CreatableSelect<UserOption, false>
                  options={members.map((m) => ({ value: m.login, label: m.login, avatarUrl: m.avatarUrl }))}
                  value={
                    measureUser
                      ? {
                          value: measureUser,
                          label: measureUser,
                          avatarUrl: members.find((m) => m.login === measureUser)?.avatarUrl,
                        }
                      : null
                  }
                  onChange={(opt) => setMeasureUser(opt?.value ?? '')}
                  placeholder={viewer ?? 'octocat'}
                  isClearable
                  formatCreateLabel={(v) => `Measure “${v}”`}
                  formatOptionLabel={(opt) =>
                    opt.__isNew__ ? (
                      <span className="text-accent">{opt.label}</span>
                    ) : (
                      <span className="flex items-center gap-2">
                        {opt.avatarUrl ? (
                          <img src={opt.avatarUrl} alt="" className="h-5 w-5 rounded-full" />
                        ) : (
                          <span className="grid h-5 w-5 place-items-center rounded-full bg-white/10 text-[10px]">
                            {opt.value[0]?.toUpperCase()}
                          </span>
                        )}
                        {opt.label}
                      </span>
                    )
                  }
                  styles={userSelectStyles}
                />
              </div>
              {members.length > 0 && (
                <p className="mt-1 font-sans text-[11px] normal-case tracking-normal text-white/30">
                  Pick from {members.length} org member{members.length > 1 ? 's' : ''} or type any login.
                </p>
              )}
            </div>

            <label className="text-xs font-medium uppercase tracking-wider text-white/45">
              Since
              <input type="date" className={inputCls} value={since} onChange={(e) => setSince(e.target.value)} />
            </label>

            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-white/45">
              <label className="flex cursor-pointer items-center gap-2">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="accent-[var(--color-accent)]" />
                Remember sign-in in this browser
              </label>
              <label className="flex cursor-pointer items-center gap-2" title="Ignore the 6-hour per-repo cache and re-fetch everything">
                <input type="checkbox" checked={refresh} onChange={(e) => setRefresh(e.target.checked)} className="accent-[var(--color-accent)]" />
                Force refresh (ignore cache)
              </label>
            </div>

            <button
              type="submit"
              disabled={!valid}
              className="mt-1 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-ink transition enabled:hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-30"
            >
              Start analysis
            </button>
          </>
        )}

        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-white/40">
          <button type="button" onClick={() => fileRef.current?.click()} className="hover:text-white">
            Load a saved JSON
          </button>
          {hasSaved && (
            <>
              <span className="text-white/15">·</span>
              <button
                type="button"
                onClick={() => {
                  [LS_TOKEN, LS_DATA, LS_CFG].forEach((k) => localStorage.removeItem(k));
                  sessionStorage.removeItem('gpp:oauth_state');
                  window.location.reload();
                }}
                className="hover:text-neg"
              >
                Clear saved token &amp; data
              </button>
            </>
          )}
          {hasData && (
            <>
              <span className="text-white/15">·</span>
              <button type="button" onClick={onBack} className="hover:text-white">
                ← Back to dashboard
              </button>
            </>
          )}
        </div>
      </form>

      <p className="mt-4 px-2 text-center text-[11px] leading-relaxed text-white/30">
        🔒 Runs entirely in your browser. Your GitHub data is fetched straight from GitHub's API and
        <strong className="font-medium text-white/45"> never sent to any server</strong>. Results and (optionally)
        your sign-in are cached only in this browser's local storage so re-runs are fast — <strong className="font-medium text-white/45">Sign out</strong> erases
        them. {oauthEnabled ? 'OAuth sign-in exchanges the login code through a stateless proxy that stores nothing.' : ''}
      </p>
      <input ref={fileRef} type="file" accept="application/json" className="hidden" onChange={onUpload} />
    </div>
  );
}

function ProgressView({ progress, onCancel }: { progress: CollectProgress | null; onCancel: () => void }) {
  const p = progress;
  // tick a local clock so the timer keeps moving even while the last repo's
  // stats are still computing (when no progress events are firing)
  const startRef = useRef(Date.now());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  const liveMs = now - startRef.current;

  const done = !!p && p.scanned >= p.total && p.total > 0;
  const rawPct = p && p.total > 0 ? (p.scanned / p.total) * 100 : 0;
  // floor so it never reads 100% until genuinely finished
  const pct = done || p?.phase === 'aggregating' || p?.phase === 'done' ? 100 : Math.floor(rawPct);
  const indeterminate = !p || p.phase === 'enumerating';
  const label =
    p?.phase === 'enumerating'
      ? 'Listing repositories…'
      : p?.phase === 'aggregating'
        ? 'Crunching the numbers…'
        : p?.phase === 'done'
          ? 'Done!'
          : 'Scanning repositories';

  return (
    <div className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-5">
      <div className="card rise p-6 sm:p-8">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium text-accent">
            <span className="glow text-xl">⚡</span> {label}
          </div>
          <span className="tnum text-sm text-white/45">{elapsed(liveMs)}</span>
        </div>

        <div className="relative mt-5 h-2.5 w-full overflow-hidden rounded-full bg-white/5">
          {indeterminate ? (
            <div className="bar-indeterminate bg-gradient-to-r from-accent to-accent-2" />
          ) : (
            <div
              className="h-full rounded-full bg-gradient-to-r from-accent to-accent-2 transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          )}
        </div>

        <div className="mt-3 flex items-center justify-between text-sm">
          <span className="text-white/55">
            {p?.phase === 'enumerating' ? (
              <>
                <span className="tnum font-semibold text-white">{p.found}</span> repos found
              </>
            ) : p && p.total > 0 ? (
              <>
                <span className="tnum font-semibold text-white">{p.scanned}</span> / {p.total} repos · {pct}%
              </>
            ) : (
              'Preparing…'
            )}
          </span>
          <span className="tnum text-white/45">
            {p ? (
              <>
                <span className="text-accent">{p.contributed}</span> contributed · {fmt(p?.commits ?? 0)} commits
              </>
            ) : null}
          </span>
        </div>

        {p?.currentRepo && (
          <p className="mt-2 truncate text-xs text-white/30">{p.currentRepo}</p>
        )}

        {p?.rateRemaining !== undefined && (
          <p className={`mt-1 text-[11px] ${p.rateRemaining < 500 ? 'text-amber' : 'text-white/25'}`}>
            GitHub API budget: {p.rateRemaining.toLocaleString()} / {(p.rateLimit ?? 5000).toLocaleString()} requests
            remaining this hour
          </p>
        )}

        <button
          onClick={onCancel}
          className="mt-6 w-full rounded-lg border border-line bg-panel-2 px-4 py-2 text-sm text-white/60 transition hover:border-neg hover:text-neg"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
