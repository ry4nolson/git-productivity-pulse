import type { Dataset, RepoTotal, RepoWeek, WeekPoint } from './types';
import { WEEK } from './data';

const API = 'https://api.github.com';

export interface CollectConfig {
  user: string;
  orgs: string[];
  users: string[];
  since?: string; // ISO date (YYYY-MM-DD)
  token: string;
  concurrency?: number;
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

/** /stats/contributors returns 202 while GitHub computes; poll with capped backoff */
async function statsContributors(
  fullName: string,
  token: string,
  signal?: AbortSignal,
  onWarm?: (attempt: number) => void,
  maxTries = 7,
): Promise<any[]> {
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
  return [];
}

interface RepoRef {
  full_name: string;
  language: string;
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
    .map((r) => ({ full_name: r.full_name, language: r.language || 'Other' }));

  if (repos.length === 0) {
    throw new GitHubError('No repositories found for those orgs/users (or the token lacks access).');
  }

  const total = repos.length;
  let scanned = 0;
  let commits = 0;
  const contributed: { repo: string; language: string; weeks: RepoWeek[] }[] = [];
  const target = cfg.user.toLowerCase();

  let idx = 0;
  async function worker() {
    while (idx < repos.length) {
      const repo = repos[idx++];
      const stats = await statsContributors(repo.full_name, cfg.token, signal, (attempt) =>
        onProgress({
          phase: 'scanning',
          scanned,
          total,
          found: total,
          contributed: contributed.length,
          commits,
          currentRepo: `${repo.full_name} · computing stats (try ${attempt})…`,
          elapsedMs: Date.now() - t0,
        }),
      );
      const mine = stats.find((s: any) => s?.author?.login?.toLowerCase() === target);
      if (mine) {
        const weeks: RepoWeek[] = (mine.weeks || [])
          .filter((w: any) => (w.c || 0) > 0 && (sinceUnix ? w.w >= sinceUnix : true))
          .map((w: any) => ({ w: w.w, c: w.c || 0, a: w.a || 0, d: w.d || 0 }));
        if (weeks.length) {
          contributed.push({ repo: repo.full_name, language: repo.language, weeks });
          commits += weeks.reduce((acc, w) => acc + w.c, 0);
        }
      }
      scanned++;
      onProgress({ phase: 'scanning', scanned, total, found: total, contributed: contributed.length, commits, currentRepo: repo.full_name, elapsedMs: Date.now() - t0 });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, repos.length) }, worker));

  onProgress({ phase: 'aggregating', scanned, total, found: total, contributed: contributed.length, commits, elapsedMs: Date.now() - t0 });
  await sleep(0, signal); // let the "Crunching…" frame paint before the synchronous build
  const dataset = buildDataset(cfg, total, contributed, t0);
  onProgress({ phase: 'done', scanned, total, found: total, contributed: contributed.length, commits: dataset.totals.commits, elapsedMs: Date.now() - t0 });
  return dataset;
}
