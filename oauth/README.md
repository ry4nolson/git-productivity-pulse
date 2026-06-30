# OAuth proxy — "Sign in with GitHub"

Lets users authorize with one click instead of creating/pasting a personal access token. GitHub's token endpoint needs a client secret and isn't CORS-enabled, so a static SPA can't do the exchange itself — this ~30-line Cloudflare Worker does it server-side. The token it returns is used by the browser to call `api.github.com` directly; nothing else is proxied.

## One-time setup (≈10 min)

### 1. Register a GitHub OAuth App
<https://github.com/settings/developers> → **New OAuth App**

| Field | Value |
|-------|-------|
| Application name | Git Productivity Pulse |
| Homepage URL | `https://ry4nolson.github.io/git-productivity-pulse/` |
| **Authorization callback URL** | `https://ry4nolson.github.io/git-productivity-pulse/` |

Click **Generate a new client secret**. Copy the **Client ID** and **Client Secret**.

> For local dev, register a second app (or add `http://localhost:5175/` — GitHub allows one extra callback per app via the app settings).

### 2. Deploy the Worker (Cloudflare, free)
```bash
cd oauth
npx wrangler deploy                       # prints the Worker URL
npx wrangler secret put GITHUB_CLIENT_ID      # paste Client ID
npx wrangler secret put GITHUB_CLIENT_SECRET  # paste Client Secret
```
`ALLOWED_ORIGIN` is already set to `https://ry4nolson.github.io` in `wrangler.toml`. Note the deployed URL, e.g. `https://gpp-oauth.<subdomain>.workers.dev`.

### 3. Turn it on for the deployed app
Set two **repo Variables** (not secrets — both are public): repo → Settings → Secrets and variables → **Actions** → **Variables** → New variable:

| Name | Value |
|------|-------|
| `VITE_GITHUB_CLIENT_ID` | the Client ID from step 1 |
| `VITE_OAUTH_PROXY_URL` | the Worker URL from step 2 |

```bash
# or from the CLI:
gh variable set VITE_GITHUB_CLIENT_ID --body "<client-id>"
gh variable set VITE_OAUTH_PROXY_URL --body "https://gpp-oauth.<subdomain>.workers.dev"
```

Re-run the Pages deploy (push any commit, or `gh workflow run deploy.yml`). The **Sign in with GitHub** button now appears; the PAT field becomes an "Advanced" fallback.

## How it flows
1. User clicks **Sign in with GitHub** → redirected to `github.com/login/oauth/authorize` (scopes `repo read:org`, random `state`).
2. GitHub redirects back to the app with `?code=…&state=…`.
3. App verifies `state`, POSTs `{ code, redirect_uri }` to the Worker.
4. Worker exchanges `code` + secret with GitHub, returns `{ access_token }`.
5. App uses the token exactly like a PAT — auto-fills username + org list, never persists it unless asked.

## Other hosts
The handler is standard `fetch`. To run on Netlify/Vercel functions instead, copy the body into the platform's function signature and read secrets from `process.env`. Contract: `POST { code, redirect_uri }` → `{ access_token }`, CORS allowing your app origin.
