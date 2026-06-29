/**
 * GitHub OAuth code-exchange proxy for Git Productivity Pulse.
 *
 * GitHub's OAuth token endpoint requires a client secret and does not send
 * CORS headers, so a static SPA cannot exchange the code itself. This tiny
 * Worker does the exchange server-side and returns the access token to the
 * app (which then talks to api.github.com directly — that endpoint *is*
 * CORS-enabled).
 *
 * Deploy (Cloudflare Workers, free tier):
 *   cd oauth
 *   npx wrangler deploy
 *   npx wrangler secret put GITHUB_CLIENT_ID
 *   npx wrangler secret put GITHUB_CLIENT_SECRET
 *   # set ALLOWED_ORIGIN in wrangler.toml to your app's origin
 *
 * The Worker URL becomes VITE_OAUTH_PROXY_URL in the app's .env.
 */

const TOKEN_URL = 'https://github.com/login/oauth/access_token';

function corsHeaders(env, origin) {
  const allowed = env.ALLOWED_ORIGIN || '*';
  const allowOrigin = allowed === '*' ? '*' : origin === allowed ? origin : allowed;
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env, request.headers.get('Origin') || '');
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, cors);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'invalid_json' }, 400, cors);
    }
    const { code, redirect_uri } = body || {};
    if (!code) return json({ error: 'missing_code' }, 400, cors);

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri,
      }),
    });
    const data = await res.json();
    if (data.error) return json({ error: data.error_description || data.error }, 400, cors);
    return json({ access_token: data.access_token, scope: data.scope, token_type: data.token_type }, 200, cors);
  },
};
