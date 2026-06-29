# ⚡ Git Productivity Pulse

A reusable dashboard that visualizes **any GitHub author's weekly output** — commits, lines added/removed, commit size, churn — across all repos in one or more orgs. Built to answer one question: **did AI change how much I ship, and when?**

The timeline is split at an adjustable "AI adoption" marker so the before/after is obvious at a glance.

**▶ Live: <https://ry4nolson.github.io/git-productivity-pulse/>** — bring a GitHub token (or wire up OAuth) and your data never leaves your browser.

![stack](https://img.shields.io/badge/Vite-React-blue) ![charts](https://img.shields.io/badge/Recharts-purple)

## How it works

It's a **100% client-side** app — no backend required (OAuth is optional, see below).

1. Open the app and paste a **personal access token**, then hit **Connect**. The app calls `/user` to auto-detect your **username** and `/user/orgs` to populate an **organization dropdown** — so you just tick the orgs to scan (or add one by name), pick a **since** date, and optionally include your personal repos.
2. The browser enumerates every repo in those orgs/users and calls GitHub's `/stats/contributors` endpoint per repo (which returns *weekly* additions/deletions/commits per author — far cheaper than walking every commit), filtering to your login. A **progress bar** tracks the scan, which can take several minutes for a large org.
3. The aggregated dataset renders into the dashboard and is cached in `localStorage`, so a refresh is instant. Hit **⚙ New analysis** to run again for someone else.

**Optional OAuth** — configure the serverless proxy in [`oauth/`](./oauth/README.md) and set `VITE_GITHUB_CLIENT_ID` + `VITE_OAUTH_PROXY_URL` (see `.env.example`) to get a **"Sign in with GitHub"** button instead of pasting a token.

> Why `/stats/contributors` and not the commit search API? The search API only indexes default-branch authored commits and **silently misses** repos you've heavily contributed to. The stats endpoint counts all of a repo's history per author and is authoritative.

## Quick start

```bash
pnpm install
pnpm dev
```

Open the printed localhost URL and fill in the form. You'll need a GitHub **personal access token** ([create one](https://github.com/settings/tokens/new?scopes=repo,read:org)) with:

- `repo` — read access to private repositories
- `read:org` — list org repositories

The token is sent **only** to `api.github.com` and stored in your browser's `localStorage` (opt-in via the "remember token" checkbox). It never touches any other server. GitHub's REST API is CORS-enabled, so the browser talks to it directly.

## Deploying for a team

`pnpm build` produces a static `dist/` you can host anywhere (Netlify, Pages, S3…). Each visitor enters their own username + token and gets their own dashboard — no per-user setup. Nothing is persisted server-side.

## Optional: CLI collector

A Node script (`scripts/collect.mjs`) does the same scan via your authenticated `gh` CLI and writes a JSON file — handy for automation/cron or sharing a snapshot. Anyone can drop that JSON onto the dashboard via **Load JSON**.

```bash
node scripts/collect.mjs --user YOUR_GH_LOGIN --orgs org1,org2 --since 2021-01-01 --out public/data/contributions.json
```

| Flag | Description | Default |
|------|-------------|---------|
| `--user` | GitHub login to measure (**required**) | — |
| `--orgs` | comma-separated orgs to scan | — |
| `--users` | comma-separated user accounts whose repos to also scan | — |
| `--since` | ISO date; drops weeks before this | all time |
| `--out` | output path | `public/data/contributions.json` |
| `--concurrency` | parallel repo fetches | `6` |

## What the charts show

- **AI-era impact** — headline multipliers comparing commits/week, LOC/week, active-week rate, and commit size before vs after the marker.
- **Commits per week** with an 8-week rolling trend.
- **Lines added vs deleted** (diverging) and **cumulative net LOC**.
- **Commit size over time** — average LOC per commit; a tighter AI loop often shows smaller, steadier commits.
- **Activity heatmap** — commits per week by calendar year.
- **Top repositories** and **languages**.

## Notes & caveats

- `/stats/contributors` attributes by the GitHub login GitHub maps each commit to; commits authored under an unlinked email won't be attributed to you.
- The first call to a repo's stats endpoint may return `202` while GitHub computes it — the collector polls with backoff automatically.
- `contributions.json` and `collect.log` are git-ignored (they're personal). Commit a sample if you want one in the repo.
- Weeks are GitHub's Sunday-aligned UTC weeks.
