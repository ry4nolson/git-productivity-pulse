import type { RepoWeek } from './types';

// Per-repo stats cache (localStorage). Keyed by repo, storing EVERY author's
// weekly data (c>0, unfiltered by `since`) — so re-runs skip the network for
// unchanged repos regardless of which user is measured or what date range is
// picked. Everything stays in the browser.
const KEY = 'gpp:statscache2';
export const CACHE_KEYS = ['gpp:statscache', KEY]; // v1 included for cleanup
export const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export type RepoAuthors = Record<string, { av: string; w: RepoWeek[] }>;

interface CacheEntry {
  authors: RepoAuthors;
  ts: number;
}
type Store = Record<string, CacheEntry>;

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null; // e.g. Node (tests) or blocked storage
  }
}

export function loadStatsCache(): Store {
  const s = storage();
  if (!s) return {};
  try {
    return JSON.parse(s.getItem(KEY) || '{}') as Store;
  } catch {
    return {};
  }
}

export function saveStatsCache(store: Store): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(KEY, JSON.stringify(store));
  } catch {
    // over quota — drop the cache rather than throw
    try {
      s.removeItem(KEY);
    } catch {
      /* ignore */
    }
  }
}

export function clearStatsCache(): void {
  const s = storage();
  for (const k of CACHE_KEYS) {
    try {
      s?.removeItem(k);
    } catch {
      /* ignore */
    }
  }
}

export function freshEntry(store: Store, repo: string, ttlMs = DEFAULT_TTL_MS): CacheEntry | undefined {
  const e = store[repo];
  return e && e.authors && Date.now() - e.ts < ttlMs ? e : undefined;
}
