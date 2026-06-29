#!/usr/bin/env node
/**
 * Git Productivity Pulse — data collector
 *
 * Scans every repository in the given GitHub orgs (and/or a user account),
 * pulls per-author weekly commit / additions / deletions stats via the
 * `/stats/contributors` endpoint, filters to the target user, and writes an
 * aggregated JSON file the React dashboard consumes.
 *
 * Requires the `gh` CLI to be installed and authenticated (`gh auth status`).
 *
 * Usage:
 *   node scripts/collect.mjs \
 *     --user YOUR_GH_LOGIN \
 *     --orgs org1,org2 \
 *     --since 2021-01-01 \
 *     --out public/data/contributions.json
 *
 * Flags:
 *   --user   GitHub login to measure (required)
 *   --orgs   comma-separated orgs to scan
 *   --users  comma-separated user accounts to scan their repos too (optional)
 *   --since  ISO date; weeks before this are dropped (default: all)
 *   --out    output path (default: public/data/contributions.json)
 *   --concurrency  parallel repo fetches (default: 6)
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const execFileAsync = promisify(execFile);

// ---------- args ----------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i];
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const USER = args.user;
const ORGS = (args.orgs ? String(args.orgs).split(',') : []).map((s) => s.trim()).filter(Boolean);
const USERS = (args.users ? String(args.users).split(',') : []).map((s) => s.trim()).filter(Boolean);
const SINCE = args.since ? Date.parse(args.since) / 1000 : 0;
const OUT = args.out || 'public/data/contributions.json';
const CONCURRENCY = Number(args.concurrency || 6);

if (!USER) {
  console.error('error: --user is required');
  process.exit(1);
}
if (ORGS.length === 0 && USERS.length === 0) {
  console.error('error: provide --orgs and/or --users to scan');
  process.exit(1);
}

// ---------- gh helpers ----------
async function gh(pathArgs) {
  const { stdout } = await execFileAsync('gh', pathArgs, { maxBuffer: 1024 * 1024 * 128 });
  return stdout;
}

async function ghJson(apiPath, { paginate = false } = {}) {
  const cmd = ['api', apiPath];
  if (paginate) cmd.push('--paginate');
  const stdout = await gh(cmd);
  const text = stdout.trim();
  if (!text) return null;
  return JSON.parse(text);
}

// Stats endpoints return 202 while GitHub computes them; body is empty/non-array.
// Retry with backoff until we get an array (even an empty one = computed).
async function fetchContributorStats(fullName, { maxTries = 8 } = {}) {
  for (let attempt = 0; attempt < maxTries; attempt++) {
    let data = null;
    try {
      data = await ghJson(`repos/${fullName}/stats/contributors`);
    } catch (e) {
      // 404/403/empty repo etc — treat as no data
      const msg = String(e.stderr || e.message || '');
      if (/404|403|409|empty/i.test(msg)) return [];
      data = null;
    }
    if (Array.isArray(data)) return data;
    // warming (202) — wait and retry
    await sleep(1500 + attempt * 1000);
  }
  return [];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- repo enumeration ----------
async function listOrgRepos(org) {
  const repos = await ghJson(`orgs/${org}/repos?per_page=100`, { paginate: true }).catch(() => []);
  return (repos || []).map((r) => ({ full_name: r.full_name, language: r.language, archived: r.archived }));
}
async function listUserRepos(user) {
  const repos = await ghJson(`users/${user}/repos?per_page=100`, { paginate: true }).catch(() => []);
  return (repos || []).map((r) => ({ full_name: r.full_name, language: r.language, archived: r.archived }));
}

// ---------- concurrency pool ----------
async function pool(items, worker, concurrency) {
  const results = [];
  let idx = 0;
  let done = 0;
  async function run() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await worker(items[i], i);
      done++;
      if (done % 10 === 0 || done === items.length) {
        process.stderr.write(`\r  progress: ${done}/${items.length} repos scanned   `);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  process.stderr.write('\n');
  return results;
}

// ---------- main ----------
(async () => {
  const t0 = Date.now();
  console.error(`Git Productivity Pulse collector`);
  console.error(`  user:  ${USER}`);
  console.error(`  orgs:  ${ORGS.join(', ') || '(none)'}`);
  console.error(`  users: ${USERS.join(', ') || '(none)'}`);
  console.error(`  since: ${args.since || '(all time)'}\n`);

  console.error('Enumerating repositories...');
  const repoLists = await Promise.all([
    ...ORGS.map(listOrgRepos),
    ...USERS.map(listUserRepos),
  ]);
  const allRepos = repoLists.flat();
  // de-dupe by full_name
  const seen = new Set();
  const repos = allRepos.filter((r) => (seen.has(r.full_name) ? false : seen.add(r.full_name)));
  console.error(`  found ${repos.length} repositories\n`);

  const langByRepo = Object.fromEntries(repos.map((r) => [r.full_name, r.language]));

  console.error('Fetching weekly contributor stats (this is the slow part)...');
  const perRepoRaw = await pool(
    repos,
    async (repo) => {
      const stats = await fetchContributorStats(repo.full_name);
      const mine = stats.find((s) => s?.author?.login?.toLowerCase() === USER.toLowerCase());
      if (!mine) return null;
      const weeks = (mine.weeks || []).filter((w) => (w.c || 0) > 0 && (SINCE ? w.w >= SINCE : true));
      if (weeks.length === 0) return null;
      return { repo: repo.full_name, language: langByRepo[repo.full_name] || 'Other', weeks };
    },
    CONCURRENCY,
  );

  const contributed = perRepoRaw.filter(Boolean);
  console.error(`\n  you contributed to ${contributed.length} repositories\n`);

  // ---------- aggregate ----------
  const weekMap = new Map(); // weekTs -> {commits, additions, deletions}
  const repoTotals = []; // {repo, language, commits, additions, deletions, weeks, firstWeek, lastWeek}
  const langTotals = new Map();

  for (const r of contributed) {
    let c = 0, a = 0, d = 0, first = Infinity, last = 0;
    for (const w of r.weeks) {
      c += w.c || 0; a += w.a || 0; d += w.d || 0;
      first = Math.min(first, w.w); last = Math.max(last, w.w);
      const cur = weekMap.get(w.w) || { commits: 0, additions: 0, deletions: 0 };
      cur.commits += w.c || 0; cur.additions += w.a || 0; cur.deletions += w.d || 0;
      weekMap.set(w.w, cur);
    }
    repoTotals.push({
      repo: r.repo, language: r.language,
      commits: c, additions: a, deletions: d,
      weeks: r.weeks.length, firstWeek: first, lastWeek: last,
      weekly: r.weeks.map((w) => ({ w: w.w, c: w.c || 0, a: w.a || 0, d: w.d || 0 })),
    });
    const lt = langTotals.get(r.language) || { commits: 0, additions: 0, deletions: 0, repos: 0 };
    lt.commits += c; lt.additions += a; lt.deletions += d; lt.repos += 1;
    langTotals.set(r.language, lt);
  }

  // fill every week in range (so the timeline has no gaps) at a 1-week cadence
  const weekKeys = [...weekMap.keys()].sort((x, y) => x - y);
  const weeks = [];
  if (weekKeys.length) {
    const WEEK = 604800;
    const start = weekKeys[0];
    const end = weekKeys[weekKeys.length - 1];
    for (let w = start; w <= end; w += WEEK) {
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
    (acc, r) => {
      acc.commits += r.commits; acc.additions += r.additions; acc.deletions += r.deletions;
      return acc;
    },
    { commits: 0, additions: 0, deletions: 0 },
  );

  const out = {
    meta: {
      user: USER,
      orgs: ORGS,
      users: USERS,
      since: args.since || null,
      generatedAt: new Date().toISOString(),
      reposScanned: repos.length,
      reposContributed: contributed.length,
      collectorSeconds: Math.round((Date.now() - t0) / 1000),
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
    languages: [...langTotals.entries()]
      .map(([language, v]) => ({ language: language || 'Other', ...v }))
      .sort((a, b) => b.additions - a.additions),
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.error(`Wrote ${OUT}`);
  console.error(`  ${totals.commits.toLocaleString()} commits · +${totals.additions.toLocaleString()} / -${totals.deletions.toLocaleString()} lines · ${contributed.length} repos · ${weeks.length} weeks`);
  console.error(`  done in ${Math.round((Date.now() - t0) / 1000)}s`);
})().catch((e) => {
  console.error('\nFATAL', e);
  process.exit(1);
});
