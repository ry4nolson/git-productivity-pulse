import type { AuthorStat, Dataset, RepoTotal, RepoWeek, WeekPoint } from './types';
import { WEEK } from './data';
import { freshEntry, loadStatsCache, saveStatsCache, type RepoAuthors } from './cache';

const API = 'https://api.github.com';

export interface CollectConfig {
  user: string;
  orgs: string[];
  users: string[];
  since?: string; // ISO date (YYYY-MM-DD)
  token: string;
  concurrency?: number;
  refresh?: boolean; // bypass the per-repo cache and re-fetch everything
}

export interface CollectProgress {
  phase: 'enumerating' | 'scanning' | 'aggregating' | 'done';
  scanned: number;
  total: number;
  found: number; // repos discovered so far (meaningful during enumeration)
  contributed: number;
  commits: number;
  currentRepo?: string;
  elapsedMs: number;
}

export class GitHubError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

function authHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

async function ghFetch(path: string, token: string, signal?: AbortSignal): Promise<Response> {
  const url = path.startsWith('http') ? path : API + path;
  const res = await fetch(url, { headers: authHeaders(token), signal });

  if (res.status === 401) throw new GitHubError('Bad credentials — check that your token is valid.', 401);

  // primary / secondary rate limiting
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    const retryAfter = Number(res.headers.get('retry-after'));
    if (remaining === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
      const mins = Math.max(1, Math.round((reset - Date.now()) / 60000));
      throw new GitHubError(`GitHub API rate limit reached. Resets in ~${mins} min.`, res.status);
    }
    // secondary limit with a short, respectable backoff
    if (retryAfter && retryAfter <= 90) {
      await sleep(retryAfter * 1000, signal);
      return ghFetch(path, token, signal);
    }
  }
  return res;
}

/** follow Link rel="next" pagination, accumulating array responses */
async function paginate(
  path: string,
  token: string,
  signal?: AbortSignal,
  onPage?: (added: number) => void,
): Promise<any[]> {
  let url = path;
  const out: any[] = [];
  while (url) {
    const res = await ghFetch(url, token, signal);
    if (res.status === 404) return out;
    if (!res.ok) throw new GitHubError(`GitHub ${res.status} while listing ${url}`, res.status);
    const page = await res.json();
    if (Array.isArray(page)) {
      out.push(...page);
      onPage?.(page.length);
    }
    const link = res.headers.get('link') || '';
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : '';
  }
  return out;
}

/**
 * /stats/contributors returns 202 while GitHub computes the stats (the first
 * request kicks off that computation server-side). Returns the array when
 * ready, [] for empty/no-access, or null if still computing after maxTries —
 * letting the caller defer and come back once GitHub has finished.
 */
async function statsContributors(
  fullName: string,
  token: string,
  signal?: AbortSignal,
  onWarm?: (attempt: number) => void,
  maxTries = 7,
): Promise<any[] | null> {
  for (let attempt = 0; attempt < maxTries; attempt++) {
    const res = await ghFetch(`/repos/${fullName}/stats/contributors`, token, signal);
    if (res.status === 202) {
      onWarm?.(attempt + 1); // surface "still computing" so the UI keeps moving
      await sleep(Math.min(4000, 1000 + attempt * 800), signal);
      continue;
    }
    if (res.status === 204) return []; // empty repo
    if (!res.ok) return []; // 403/404/409 (no access / DMCA / empty) — skip
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  }
  return null; // still computing after maxTries — defer
}

interface RepoRef {
  full_name: string;
  language: string;
  fork: boolean;
}

export interface GhUser {
  login: string;
  name: string | null;
  avatarUrl: string;
}

export interface GhOrg {
  login: string;
  avatarUrl: string;
}

/** the authenticated user behind a token */
export async function getViewer(token: string, signal?: AbortSignal): Promise<GhUser> {
  const res = await ghFetch('/user', token, signal);
  if (!res.ok) throw new GitHubError(`Couldn't verify token (GitHub ${res.status}).`, res.status);
  const u = await res.json();
  return { login: u.login, name: u.name ?? null, avatarUrl: u.avatar_url };
}

export interface OrgMember {
  login: string;
  avatarUrl: string;
}

/** members of an org (requires the token's user to be a member; else empty) */
export async function listOrgMembers(org: string, token: string, signal?: AbortSignal): Promise<OrgMember[]> {
  const members = await paginate(`/orgs/${encodeURIComponent(org)}/members?per_page=100`, token, signal).catch(() => []);
  return members.map((m: any) => ({ login: m.login, avatarUrl: m.avatar_url || '' }));
}

/** orgs the token's user belongs to (needs read:org for private orgs) */
export async function listOrgs(token: string, signal?: AbortSignal): Promise<GhOrg[]> {
  const orgs = await paginate('/user/orgs?per_page=100', token, signal);
  return orgs
    .map((o: any) => ({ login: o.login, avatarUrl: o.avatar_url }))
    .sort((a: GhOrg, b: GhOrg) => a.login.localeCompare(b.login));
}

/** exchange an OAuth code for an access token via the configured proxy */
export async function exchangeOAuthCode(proxyUrl: string, code: string, redirectUri: string): Promise<string> {
  const res = await fetch(proxyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, redirect_uri: redirectUri }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new GitHubError(data.error || `OAuth exchange failed (${res.status}).`);
  }
  return data.access_token as string;
}

function buildDataset(
  cfg: CollectConfig,
  reposScanned: number,
  contributed: { repo: string; language: string; weeks: RepoWeek[] }[],
  startedAt: number,
): Dataset {
  const weekMap = new Map<number, { commits: number; additions: number; deletions: number }>();
  const repoTotals: RepoTotal[] = [];
  const langMap = new Map<string, { commits: number; additions: number; deletions: number; repos: number }>();

  for (const r of contributed) {
    let c = 0, a = 0, d = 0, first = Infinity, last = 0;
    for (const w of r.weeks) {
      c += w.c; a += w.a; d += w.d;
      first = Math.min(first, w.w);
      last = Math.max(last, w.w);
      const cur = weekMap.get(w.w) || { commits: 0, additions: 0, deletions: 0 };
      cur.commits += w.c;
      cur.additions += w.a;
      cur.deletions += w.d;
      weekMap.set(w.w, cur);
    }
    repoTotals.push({
      repo: r.repo,
      language: r.language,
      commits: c,
      additions: a,
      deletions: d,
      weeks: r.weeks.length,
      firstWeek: first,
      lastWeek: last,
      weekly: r.weeks,
    });
    const lt = langMap.get(r.language) || { commits: 0, additions: 0, deletions: 0, repos: 0 };
    lt.commits += c;
    lt.additions += a;
    lt.deletions += d;
    lt.repos += 1;
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

  repoTotals.sort((a, b) => b.commits - a.commits);
  const totals = repoTotals.reduce(
    (acc, r) => ({ commits: acc.commits + r.commits, additions: acc.additions + r.additions, deletions: acc.deletions + r.deletions }),
    { commits: 0, additions: 0, deletions: 0 },
  );

  return {
    meta: {
      user: cfg.user,
      orgs: cfg.orgs,
      users: cfg.users,
      since: cfg.since || null,
      generatedAt: new Date().toISOString(),
      reposScanned,
      reposContributed: contributed.length,
      collectorSeconds: Math.round((Date.now() - startedAt) / 1000),
    },
    totals: {
      ...totals,
      net: totals.additions - totals.deletions,
      churn: totals.additions + totals.deletions,
      weeksActive: weeks.filter((w) => w.commits > 0).length,
      weeksSpan: weeks.length,
    },
    weeks,
    repos: repoTotals,
    languages: [...langMap.entries()]
      .map(([language, v]) => ({ language: language || 'Other', ...v }))
      .sort((a, b) => b.additions - a.additions),
  };
}

/**
 * Collect a contribution Dataset entirely in the browser via the GitHub REST
 * API. Enumerates every repo in the given orgs/users, pulls weekly per-author
 * stats, filters to cfg.user, and aggregates. Reports progress continuously.
 */
export async function collect(
  cfg: CollectConfig,
  onProgress: (p: CollectProgress) => void,
  signal?: AbortSignal,
): Promise<Dataset> {
  const t0 = Date.now();
  const sinceUnix = cfg.since ? Math.floor(Date.parse(cfg.since) / 1000) : 0;
  const concurrency = Math.max(1, Math.min(cfg.concurrency ?? 8, 12));

  let found = 0;
  onProgress({ phase: 'enumerating', scanned: 0, total: 0, found: 0, contributed: 0, commits: 0, currentRepo: 'listing repositories…', elapsedMs: 0 });
  const onPage = (added: number) => {
    found += added;
    onProgress({ phase: 'enumerating', scanned: 0, total: 0, found, contributed: 0, commits: 0, currentRepo: `${found} repositories found…`, elapsedMs: Date.now() - t0 });
  };

  const lists = await Promise.all([
    ...cfg.orgs.map((o) => paginate(`/orgs/${encodeURIComponent(o)}/repos?per_page=100&type=all`, cfg.token, signal, onPage)),
    ...cfg.users.map((u) => paginate(`/users/${encodeURIComponent(u)}/repos?per_page=100`, cfg.token, signal, onPage)),
  ]);

  const seen = new Set<string>();
  const repos: RepoRef[] = lists
    .flat()
    .filter((r) => r && r.full_name && !seen.has(r.full_name) && seen.add(r.full_name))
    .map((r) => ({ full_name: r.full_name, language: r.language || 'Other', fork: !!r.fork }));

  if (repos.length === 0) {
    throw new GitHubError('No repositories found for those orgs/users (or the token lacks access).');
  }

  const total = repos.length;
  let scanned = 0;
  let commits = 0;
  const contributed: { repo: string; language: string; weeks: RepoWeek[] }[] = [];
  const target = cfg.user.toLowerCase();
  const cache = loadStatsCache();
  const useCache = !cfg.refresh;

  const emitScan = (currentRepo: string) =>
    onProgress({ phase: 'scanning', scanned, total, found: total, contributed: contributed.length, commits, currentRepo, elapsedMs: Date.now() - t0 });

  // every author's weeks in a repo (c>0), UNfiltered by `since` so the cache
  // stays valid regardless of the selected start date or measured user
  const authorsFromStats = (stats: any[]): RepoAuthors => {
    const out: RepoAuthors = {};
    for (const s of stats) {
      const login = s?.author?.login;
      if (!login) continue;
      const w: RepoWeek[] = (s.weeks || [])
        .filter((x: any) => (x.c || 0) > 0)
        .map((x: any) => ({ w: x.w, c: x.c || 0, a: x.a || 0, d: x.d || 0 }));
      if (w.length) out[login] = { av: s.author.avatar_url || '', w };
    }
    return out;
  };

  // aggregate every author for the leaderboard; pull the measured user's
  // weeks out of the same data for the per-repo dashboard breakdowns
  const authorAgg = new Map<string, { av: string; repos: number; weeks: Map<number, { c: number; a: number; d: number }> }>();
  const applyRepo = (repo: RepoRef, ra: RepoAuthors) => {
    for (const [login, v] of Object.entries(ra)) {
      const weeks = sinceUnix ? v.w.filter((w) => w.w >= sinceUnix) : v.w;
      if (!weeks.length) continue;
      if (login.toLowerCase() === target) {
        contributed.push({ repo: repo.full_name, language: repo.language, weeks });
        commits += weeks.reduce((acc, w) => acc + w.c, 0);
      }
      // forks inherit the upstream's whole contributor history — counting it
      // would flood the leaderboard with people who never touched this org
      if (repo.fork && login.toLowerCase() !== target) continue;
      const agg = authorAgg.get(login) ?? { av: v.av, repos: 0, weeks: new Map() };
      if (!agg.av && v.av) agg.av = v.av;
      agg.repos++;
      for (const w of weeks) {
        const cur = agg.weeks.get(w.w) ?? { c: 0, a: 0, d: 0 };
        cur.c += w.c;
        cur.a += w.a;
        cur.d += w.d;
        agg.weeks.set(w.w, cur);
      }
      authorAgg.set(login, agg);
    }
    scanned++;
  };
  const store = (repo: RepoRef, ra: RepoAuthors) => {
    cache[repo.full_name] = { authors: ra, ts: Date.now() };
  };

  const runPool = (work: () => Promise<void>, count: number) =>
    Promise.all(Array.from({ length: Math.max(0, Math.min(concurrency, count)) }, work));

  // Pass 1 — cache hit → skip the network entirely; otherwise touch the repo
  // (which kicks off GitHub's server-side stats computation). Repos still
  // computing are deferred so we don't serialize on them at the tail.
  const pending: RepoRef[] = [];
  let idx = 0;
  await runPool(async () => {
    while (idx < repos.length) {
      const repo = repos[idx++];
      const hit = useCache ? freshEntry(cache, repo.full_name) : undefined;
      if (hit) {
        applyRepo(repo, hit.authors);
        emitScan(`${repo.full_name} · cached`);
        continue;
      }
      const stats = await statsContributors(repo.full_name, cfg.token, signal, undefined, 2);
      if (stats === null) {
        pending.push(repo);
        emitScan(`${repo.full_name} · GitHub is computing stats…`);
      } else {
        const ra = authorsFromStats(stats);
        store(repo, ra);
        applyRepo(repo, ra);
        emitScan(repo.full_name);
      }
    }
  }, repos.length);

  // Pass 2 — revisit deferred repos. GitHub has been computing them during
  // pass 1, so they're usually ready now. Bound the wait (~25s): a repo pushed
  // seconds ago can take GitHub a minute to compute, and we won't hang the
  // whole run on it — skip it (a re-run shortly after will include it).
  const skipped: string[] = [];
  let pidx = 0;
  await runPool(async () => {
    while (pidx < pending.length) {
      const repo = pending[pidx++];
      const left = pending.length - pidx + 1;
      emitScan(`Finishing — GitHub is still computing stats for ${left} recently-pushed repo(s)…`);
      const stats = await statsContributors(repo.full_name, cfg.token, signal, undefined, 8);
      if (stats === null) {
        skipped.push(repo.full_name); // still computing — skip rather than hang
        scanned++;
      } else {
        const ra = authorsFromStats(stats);
        store(repo, ra);
        applyRepo(repo, ra);
      }
      emitScan(repo.full_name);
    }
  }, pending.length);

  saveStatsCache(cache);

  onProgress({ phase: 'aggregating', scanned, total, found: total, contributed: contributed.length, commits, elapsedMs: Date.now() - t0 });
  await sleep(0, signal); // let the "Crunching…" frame paint before the synchronous build
  const dataset = buildDataset(cfg, total, contributed, t0);
  dataset.authors = [...authorAgg.entries()]
    .map(([login, v]): AuthorStat => ({
      login,
      avatarUrl: v.av,
      repos: v.repos,
      weekly: [...v.weeks.entries()].sort((x, y) => x[0] - y[0]).map(([w, t]) => ({ w, c: t.c, a: t.a, d: t.d })),
    }))
    .sort((x, y) => y.weekly.reduce((s, w) => s + w.c, 0) - x.weekly.reduce((s, w) => s + w.c, 0));
  if (skipped.length) dataset.meta.skipped = skipped;
  onProgress({ phase: 'done', scanned, total, found: total, contributed: contributed.length, commits: dataset.totals.commits, elapsedMs: Date.now() - t0 });
  return dataset;
}
