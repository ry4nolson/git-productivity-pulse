# OAuth proxy

Optional serverless function that lets users **"Sign in with GitHub"** instead of pasting a personal access token. Without it, the app falls back to the PAT flow (which still auto-fills username + orgs).

## Why a server is needed

GitHub's OAuth token endpoint (`github.com/login/oauth/access_token`) requires a `client_secret` and does **not** send CORS headers — a browser can't call it. This Worker performs the code→token exchange server-side. The returned token is used by the browser to call `api.github.com` directly (that endpoint *is* CORS-enabled), so no other traffic is proxied.

## Setup

1. **Register a GitHub OAuth App** — <https://github.com/settings/developers> → New OAuth App
   - Homepage URL: your app origin (e.g. `https://pulse.example.com` or `http://localhost:5175`)
   - **Authorization callback URL**: the same app origin (the app reads `?code=` off its own URL)
   - Note the **Client ID** and generate a **Client Secret**.

2. **Deploy the Worker** (Cloudflare, free):
   ```bash
   cd oauth
   npx wrangler deploy
   npx wrangler secret put GITHUB_CLIENT_ID       # paste client id
   npx wrangler secret put GITHUB_CLIENT_SECRET   # paste client secret
   ```
   Set `ALLOWED_ORIGIN` in `wrangler.toml` to your app origin, then redeploy.

3. **Point the app at it** — in the project root `.env` (see `.env.example`):
   ```
   VITE_GITHUB_CLIENT_ID=Iv1.xxxxxxxx
   VITE_OAUTH_PROXY_URL=https://gpp-oauth.<your-subdomain>.workers.dev
   ```
   Rebuild/restart. A **Sign in with GitHub** button appears on the setup screen.

## Other hosts

The handler is ~30 lines of standard `fetch`. To run it on Netlify/Vercel functions instead, copy the body of the `fetch` handler into the platform's function signature and read the secrets from `process.env`. The contract is: `POST { code, redirect_uri }` → `{ access_token }`, with CORS allowing your app origin.
