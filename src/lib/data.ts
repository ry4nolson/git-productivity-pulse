import type { Dataset, RepoTotal, WeekPoint } from './types';

export const WEEK = 604800;

/**
 * Rebuild a Dataset scoped to [startUnix, endUnix] from per-repo weekly data.
 * Recomputes the global weekly timeline, repo totals, language totals and
 * grand totals so every chart on the page reflects the selected range.
 * Falls back to the original dataset when per-repo weekly data is absent.
 */
export function deriveDataset(raw: Dataset, startUnix: number, endUnix: number): Dataset {
  const hasWeekly = raw.repos.some((r) => r.weekly && r.weekly.length);
  if (!hasWeekly) return raw;

  const weekMap = new Map<number, { commits: number; additions: number; deletions: number }>();
  const repos: RepoTotal[] = [];
  const langMap = new Map<string, { commits: number; additions: number; deletions: number; repos: number }>();

  for (const r of raw.repos) {
    const inRange = (r.weekly ?? []).filter((w) => w.w >= startUnix && w.w <= endUnix);
    if (inRange.length === 0) continue;
    let c = 0, a = 0, d = 0, first = Infinity, last = 0;
    for (const w of inRange) {
      c += w.c; a += w.a; d += w.d;
      first = Math.min(first, w.w); last = Math.max(last, w.w);
      const cur = weekMap.get(w.w) || { commits: 0, additions: 0, deletions: 0 };
      cur.commits += w.c; cur.additions += w.a; cur.deletions += w.d;
      weekMap.set(w.w, cur);
    }
    if (c === 0) continue;
    repos.push({ ...r, commits: c, additions: a, deletions: d, weeks: inRange.length, firstWeek: first, lastWeek: last });
    const lt = langMap.get(r.language) || { commits: 0, additions: 0, deletions: 0, repos: 0 };
    lt.commits += c; lt.additions += a; lt.deletions += d; lt.repos += 1;
    langMap.set(r.language, lt);
  }

  const keys = [...weekMap.keys()].sort((x, y) => x - y);
  const weeks: WeekPoint[] = [];
  if (keys.length) {
    for (let w = keys[0]; w <= keys[keys.length - 1]; w += WEEK) {
      const v = weekMap.get(w) || { commits: 0, additions: 0, deletions: 0 };
      weeks.push({
        week: w,
        date: new Date(w * 1000).toISOString().slice(0, 10),
        commits: v.commits,
        additions: v.additions,
        deletions: v.deletions,
        net: v.additions - v.deletions,
        churn: v.additions + v.deletions,
        avgCommitSize: v.commits ? Math.round((v.additions + v.deletions) / v.commits) : 0,
      });
    }
  }

  repos.sort((a, b) => b.commits - a.commits);
  const totals = repos.reduce(
    (acc, r) => ({ commits: acc.commits + r.commits, additions: acc.additions + r.additions, deletions: acc.deletions + r.deletions }),
    { commits: 0, additions: 0, deletions: 0 },
  );

  return {
    ...raw,
    meta: { ...raw.meta, reposContributed: repos.length },
    totals: {
      ...totals,
      net: totals.additions - totals.deletions,
      churn: totals.additions + totals.deletions,
      weeksActive: weeks.filter((w) => w.commits > 0).length,
      weeksSpan: weeks.length,
    },
    weeks,
    repos,
    languages: [...langMap.entries()]
      .map(([language, v]) => ({ language: language || 'Other', ...v }))
      .sort((a, b) => b.additions - a.additions),
  };
}

export function fmt(n: number): string {
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n));
}

export function fmtFull(n: number): string {
  return Math.round(n).toLocaleString();
}

/** rolling N-week trailing average of a numeric field */
export function rolling(weeks: WeekPoint[], field: keyof WeekPoint, window: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < weeks.length; i++) {
    sum += weeks[i][field] as number;
    if (i >= window) sum -= weeks[i - window][field] as number;
    const denom = Math.min(i + 1, window);
    out.push(sum / denom);
  }
  return out;
}

export interface EraSplit {
  preWeeks: WeekPoint[];
  postWeeks: WeekPoint[];
  pre: EraStats;
  post: EraStats;
  delta: {
    commitsPerWeek: number; // ratio (post/pre)
    churnPerWeek: number;
    netPerWeek: number;
    activeRate: number; // pct point change in active-week rate
  };
}
export interface EraStats {
  label: string;
  weeks: number;
  activeWeeks: number;
  commits: number;
  additions: number;
  deletions: number;
  churn: number;
  net: number;
  commitsPerWeek: number;
  churnPerWeek: number;
  netPerWeek: number;
  avgCommitSize: number;
  activeRate: number;
}

function eraStats(label: string, weeks: WeekPoint[]): EraStats {
  const n = weeks.length || 1;
  const active = weeks.filter((w) => w.commits > 0).length;
  const commits = sum(weeks, 'commits');
  const additions = sum(weeks, 'additions');
  const deletions = sum(weeks, 'deletions');
  const churn = additions + deletions;
  return {
    label,
    weeks: weeks.length,
    activeWeeks: active,
    commits,
    additions,
    deletions,
    churn,
    net: additions - deletions,
    commitsPerWeek: commits / n,
    churnPerWeek: churn / n,
    netPerWeek: (additions - deletions) / n,
    avgCommitSize: commits ? Math.round(churn / commits) : 0,
    activeRate: active / n,
  };
}

function sum(weeks: WeekPoint[], f: keyof WeekPoint): number {
  return weeks.reduce((a, w) => a + (w[f] as number), 0);
}

/** split the timeline at the AI-adoption marker date (unix seconds) */
export function splitByEra(ds: Dataset, markerUnix: number, weeksOverride?: WeekPoint[]): EraSplit {
  const allWeeks = weeksOverride ?? ds.weeks;
  const pre = allWeeks.filter((w) => w.week < markerUnix);
  const post = allWeeks.filter((w) => w.week >= markerUnix);
  const preStats = eraStats('Pre-AI', pre);
  const postStats = eraStats('AI era', post);
  return {
    preWeeks: pre,
    postWeeks: post,
    pre: preStats,
    post: postStats,
    delta: {
      commitsPerWeek: ratio(postStats.commitsPerWeek, preStats.commitsPerWeek),
      churnPerWeek: ratio(postStats.churnPerWeek, preStats.churnPerWeek),
      netPerWeek: ratio(postStats.netPerWeek, preStats.netPerWeek),
      activeRate: postStats.activeRate - preStats.activeRate,
    },
  };
}

function ratio(a: number, b: number): number {
  if (!b) return a ? Infinity : 0;
  return a / b;
}

/** group weekly points into calendar months for coarser charts */
export function byMonth(weeks: WeekPoint[]) {
  const m = new Map<string, { month: string; commits: number; additions: number; deletions: number }>();
  for (const w of weeks) {
    const key = w.date.slice(0, 7);
    const cur = m.get(key) || { month: key, commits: 0, additions: 0, deletions: 0 };
    cur.commits += w.commits;
    cur.additions += w.additions;
    cur.deletions += w.deletions;
    m.set(key, cur);
  }
  return [...m.values()];
}

/** build a year × week-of-year matrix of commits for a heatmap */
export function heatmap(weeks: WeekPoint[]) {
  const years = new Map<number, { year: number; cells: { week: number; commits: number; date: string }[] }>();
  for (const w of weeks) {
    const d = new Date(w.week * 1000);
    const year = d.getUTCFullYear();
    if (!years.has(year)) years.set(year, { year, cells: [] });
    years.get(year)!.cells.push({ week: weekOfYear(d), commits: w.commits, date: w.date });
  }
  return [...years.values()].sort((a, b) => a.year - b.year);
}

function weekOfYear(d: Date): number {
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.floor((d.getTime() - start) / (WEEK * 1000));
}

export function markerToUnix(dateStr: string): number {
  return Math.floor(Date.parse(dateStr + 'T00:00:00Z') / 1000);
}

// GitHub's weekly buckets start on Sundays (UTC); 1970-01-04 was a Sunday
export function floorWeek(unix: number): number {
  return unix - ((((unix - 259200) % WEEK) + WEEK) % WEEK);
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

/**
 * GitHub's /stats/contributors counts every line, including committed
 * lockfiles, vendored deps and generated bundles — which produce a handful of
 * multi-million-line weeks that flatten every chart. This winsorizes weekly
 * additions/deletions at a percentile of churn (preserving the add/del ratio)
 * so the trends are legible. Commit counts are never touched.
 */
export function clipWeeks(weeks: WeekPoint[], p = 0.98): { weeks: WeekPoint[]; threshold: number; clipped: number } {
  const threshold = percentile(weeks.map((w) => w.churn), p);
  let clipped = 0;
  const out = weeks.map((w) => {
    if (w.churn <= threshold || w.churn === 0) return w;
    clipped++;
    const factor = threshold / w.churn;
    const additions = Math.round(w.additions * factor);
    const deletions = Math.round(w.deletions * factor);
    return {
      ...w,
      additions,
      deletions,
      net: additions - deletions,
      churn: additions + deletions,
      avgCommitSize: w.commits ? Math.round((additions + deletions) / w.commits) : 0,
    };
  });
  return { weeks: out, threshold, clipped };
}
