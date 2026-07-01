import type { RepoWeek } from './types';

// Per-repo stats cache (localStorage). Keyed by user+repo, stores the author's
// unfiltered weekly data (or null for no contribution) so re-runs skip the
// network for repos GitHub hasn't changed. Everything stays in the browser.
const KEY = 'gpp:statscache';
export const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

interface CacheEntry {
  weeks: RepoWeek[] | null;
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
  try {
    s?.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function cacheKey(user: string, repo: string): string {
  return `${user.toLowerCase()}:${repo}`;
}

export function freshEntry(store: Store, key: string, ttlMs = DEFAULT_TTL_MS): CacheEntry | undefined {
  const e = store[key];
  return e && Date.now() - e.ts < ttlMs ? e : undefined;
}
