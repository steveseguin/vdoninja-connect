import http from 'node:http';
import { availableParallelism, homedir } from 'node:os';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { HostedStore, opaque, hash } from './hosted-store.mjs';
import { HostedPeers } from './hosted-peer.mjs';
import { hostedTools } from './hosted-tools.mjs';

const PAGE = 'https://steveseguin.github.io/vdoninja-connect/';
function escape(text) { return String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function equal(a, b) { const x = Buffer.from(a || ''), y = Buffer.from(b || ''); return x.length === y.length && timingSafeEqual(x, y); }
function failure(message, status = 400) { return Object.assign(new Error(message), { status }); }
async function body(req, maximum) {
  let size = 0; const parts = [];
  for await (const part of req) { size += part.length; if (size > maximum) throw failure('Request too large', 413); parts.push(part); }
  return Buffer.concat(parts).toString('utf8');
}
function invitation(text) {
  if (typeof text !== 'string' || text.length > 4096) throw failure('Paste one fresh invitation link.');
  let value;
  try { value = JSON.parse(new URLSearchParams(new URL(text).hash.slice(1)).get('invitation')); } catch { throw failure('Invalid invitation link.'); }
  if (!value || !/^[a-zA-Z0-9_-]{8,128}$/.test(value.room) || !/^[a-zA-Z0-9_-]{8,128}$/.test(value.service) ||
      !/^[a-f0-9-]{36}$/.test(value.peer) || !/^[a-f0-9]{48}$/.test(value.password) ||
      !/^[A-Za-z0-9+/]{43}=$/.test(value.key) || !Number.isSafeInteger(value.expires) || value.expires <= Date.now()) throw failure('Invalid or expired invitation. Create a new invitation on the agent computer.');
  return { room: value.room, password: value.password, service: value.service, peer: value.peer, key: value.key, expires: value.expires };
}
function consentPage(ticket, clientName, redirect, error = '') {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect your agent · VDO.Ninja</title><style>body{font:17px/1.55 system-ui;background:#0c1620;color:#e9f4f6;max-width:640px;margin:6vh auto;padding:24px}h1{line-height:1.2}input[type=password]{display:block;width:100%;box-sizing:border-box;border:1px solid #62808e;background:#142330;color:inherit;padding:12px;border-radius:8px}button{background:#4bdbc1;color:#072a28;padding:12px 20px;border:0;border-radius:8px;font:inherit;margin-top:14px}a{color:#69e1cc}.error{color:#ffb5b5}small{color:#adc2ce}code{overflow-wrap:anywhere}</style><h1>Connect your background agent</h1><p><strong>${escape(clientName)}</strong> wants permission to send messages to your agent, start model turns, read replies, exchange selected text files and cancel its requests.</p><p>No VDO.Ninja account is needed. Generate a new invitation on your agent computer:</p><p><code>npm run background -- invite "ChatGPT"</code></p><p>The hosted connector will hold this pairing's replacement key and process the messages and files you explicitly send through it. Your computer must stay awake. Model requests use your configured Codex allowance.</p>${error ? `<p class="error">${escape(error)}</p>` : ''}<form method="post" action="/consent"><input type="hidden" name="ticket" value="${escape(ticket)}"><label for="invitation">Paste the private invitation here, not into a chat message.</label><input type="password" name="invitation" id="invitation" maxlength="4096" required autocomplete="off" spellcheck="false"><button name="decision" value="allow">Pair and allow access</button> <button name="decision" value="deny" formnovalidate>Cancel</button></form><p><small>Return destination: ${escape(new URL(redirect).origin)}. This authorization lasts up to seven days. Revoke the pairing on your computer or use Disconnect agent to end hosted access.</small></p><p><a href="${PAGE}privacy.html">Privacy</a> · <a href="${PAGE}terms.html">Terms</a> · <a href="${PAGE}support.html">Help</a></p></html>`;
}

export async function startHosted(options = {}) {
  const port = options.port ?? Number(process.env.PORT || 8788);
  const origin = options.origin || process.env.VDONINJA_HOSTED_ORIGIN;
  if (!origin) throw new Error('Set VDONINJA_HOSTED_ORIGIN to the public HTTPS origin.');
  const parsed = new URL(origin);
  const local = ['127.0.0.1', 'localhost'].includes(parsed.hostname);
  if ((parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) || parsed.origin !== origin || parsed.username || parsed.password) throw new Error('Use an HTTPS origin without a path or trailing slash (HTTP loopback is allowed for local validation).');
  const resource = origin + '/mcp';
  const allowed = options.redirects || (process.env.VDONINJA_OAUTH_REDIRECTS || '').split(',').filter(Boolean);
  if (!allowed.length) throw new Error('Set VDONINJA_OAUTH_REDIRECTS to exact callback URLs from the client management page.');
  for (const url of allowed) {
    const u = new URL(url);
    if (u.hash || u.username || u.password || (u.protocol !== 'https:' && !(local && ['localhost', '127.0.0.1'].includes(u.hostname)))) throw new Error('Invalid OAuth redirect allowlist');
  }
  const store = new HostedStore(options.root || process.env.VDONINJA_HOSTED_DATA || path.join(homedir(), '.vdoninja-connect/hosted'), options.secret || process.env.VDONINJA_HOSTED_SECRET);
  const peers = options.peers || new HostedPeers(store, Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2))));
  const tickets = new Map(), rates = new Map(); let inflight = 0, stopping = false;
  const maintenance = setInterval(() => {
    const now = Date.now();
    for (const [id, ticket] of tickets) if (ticket.expires < now) tickets.delete(id);
    for (const [ip, entry] of rates) if (entry.until < now) rates.delete(ip);
    for (const [id, grant] of Object.entries(store.data.grants)) if (grant.expires <= now) { store.remove(id); void peers.close(id); }
    for (const table of ['codes', 'tokens', 'refresh']) for (const [id, entry] of Object.entries(store.data[table])) if (entry.expires < now) delete store.data[table][id];
    store.save(); void peers.sweep();
  }, 60000); maintenance.unref();
  const server = http.createServer(async (req, res) => {
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    // Same-origin forms need a non-opaque Origin for CSRF validation. External
    // redirects still receive no Referer with this policy.
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    if (!local) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      if (stopping) return json(503, { error: 'temporarily_unavailable' });
      if (req.headers.host !== parsed.host && req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return json(400, { error: 'invalid_host' });
      const url = new URL(req.url, origin);
      if (url.pathname === '/health' && req.method === 'GET') return json(200, { status: 'ok' });
      const rateKey = req.socket.remoteAddress || 'unknown';
      let rate = rates.get(rateKey);
      if (!rate || rate.until < Date.now()) {
        if (rates.size >= 1024) return json(503, { error: 'temporarily_unavailable' });
        rate = { count: 0, until: Date.now() + 60000 }; rates.set(rateKey, rate);
      }
      if (++rate.count > 180 || inflight >= 16) { res.setHeader('Retry-After', '60'); return json(429, { error: 'rate_limited' }); }
      if (req.headers.origin && req.headers.origin !== origin) return json(403, { error: 'invalid_origin' });
      if (url.pathname === '/.well-known/oauth-protected-resource/mcp' || url.pathname === '/.well-known/oauth-protected-resource') return json(200, {
        resource, authorization_servers: [origin], scopes_supported: ['agent:connect'], resource_name: 'VDO.Ninja Connect',
        resource_documentation: PAGE + 'product.html', resource_policy_uri: PAGE + 'privacy.html', resource_tos_uri: PAGE + 'terms.html'
      });
      if (url.pathname === '/.well-known/oauth-authorization-server') return json(200, { issuer: origin,
        authorization_endpoint: origin + '/authorize', token_endpoint: origin + '/token', registration_endpoint: origin + '/register',
        revocation_endpoint: origin + '/revoke', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'], scopes_supported: ['agent:connect'], token_endpoint_auth_methods_supported: ['none'] });
      if (url.pathname === '/register' && req.method === 'POST') {
        const data = JSON.parse(await body(req, 8192));
        if (Object.keys(store.data.clients).length >= 1000) throw failure('Registration capacity reached', 503);
        if (!Array.isArray(data.redirect_uris) || !data.redirect_uris.length || data.redirect_uris.length > 4 || data.redirect_uris.some(u => !allowed.includes(u))) throw failure('invalid_redirect_uri');
        if (data.token_endpoint_auth_method && data.token_endpoint_auth_method !== 'none') throw failure('Only public PKCE clients are supported.');
        const id = opaque();
        const client = { client_id: id, client_name: String(data.client_name || 'Agent client').slice(0, 80), redirect_uris: data.redirect_uris,
          grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
        store.data.clients[id] = { ...client, created: Date.now() }; store.save();
        return json(201, client);
      }
      if (url.pathname === '/authorize' && req.method === 'GET') {
        const q = url.searchParams, client = store.data.clients[q.get('client_id')];
        if (!client || !client.redirect_uris.includes(q.get('redirect_uri'))) throw failure('invalid_client');
        if (q.get('resource') !== resource || q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !/^[a-zA-Z0-9_-]{43}$/.test(q.get('code_challenge') || '') || (q.get('scope') || 'agent:connect') !== 'agent:connect') throw failure('invalid_request');
        if ((q.get('state') || '').length > 512 || tickets.size >= 100) throw failure('invalid_request');
        const id = opaque(), csrf = opaque();
        tickets.set(id, { csrf: hash(csrf), client: client.client_id, redirect: q.get('redirect_uri'), state: q.get('state'), challenge: q.get('code_challenge'), expires: Date.now() + 300000 });
        res.setHeader('Set-Cookie', `vdo_consent=${csrf}; HttpOnly; SameSite=Lax; Path=/consent; Max-Age=300${local ? '' : '; Secure'}`);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(consentPage(id, client.client_name, q.get('redirect_uri'))); return;
      }
      if (url.pathname === '/consent' && req.method === 'POST') {
        const form = new URLSearchParams(await body(req, 8192));
        const id = form.get('ticket'), ticket = tickets.get(id);
        const cookie = /(?:^|;\s*)vdo_consent=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || '')?.[1];
        if (!ticket || ticket.expires < Date.now() || !equal(ticket.csrf, hash(cookie || '')) || req.headers.origin !== origin) throw failure('Consent session expired or invalid. Restart authorization.', 403);
        tickets.delete(id);
        const redirect = new URL(ticket.redirect); if (ticket.state) redirect.searchParams.set('state', ticket.state);
        if (form.get('decision') === 'deny') { redirect.searchParams.set('error', 'access_denied'); res.writeHead(302, { Location: redirect.href }); res.end(); return; }
        if (form.get('decision') !== 'allow') throw failure('invalid_request');
        if (Object.keys(store.data.grants).length >= 100) throw failure('Connection capacity reached. Try again later.', 503);
        const credentials = invitation(form.get('invitation'));
        if (Object.values(store.data.grants).some(g => g.credentials.peer === credentials.peer && g.credentials.service === credentials.service)) throw failure('This invitation already belongs to a connection. Generate a fresh invitation.');
        const grant = { id: opaque(), client: ticket.client, credentials, expires: Math.min(credentials.expires, Date.now() + 7 * 86400000), requests: {} };
        store.data.grants[grant.id] = grant; store.save(); inflight++;
        try { await peers.open(grant); }
        catch (error) { store.remove(grant.id); throw failure(error.message, 503); }
        finally { inflight--; }
        const code = opaque(); store.data.codes[hash(code)] = { grant: grant.id, redirect: ticket.redirect, challenge: ticket.challenge, expires: Date.now() + 60000 }; store.save();
        redirect.searchParams.set('code', code); res.writeHead(302, { Location: redirect.href }); res.end(); return;
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        const data = new URLSearchParams(await body(req, 8192));
        if (data.get('resource') !== resource) throw failure('invalid_target');
        if (data.get('grant_type') === 'authorization_code') {
          const codeHash = hash(data.get('code') || ''), entry = store.data.codes[codeHash], grant = entry && store.data.grants[entry.grant];
          const verifier = data.get('code_verifier') || '';
          const challenge = createHash('sha256').update(verifier).digest('base64url');
          if (!entry || !grant || entry.expires < Date.now() || grant.expires < Date.now() || grant.client !== data.get('client_id') || entry.redirect !== data.get('redirect_uri') || !/^[a-zA-Z0-9._~-]{43,128}$/.test(verifier) || !equal(challenge, entry.challenge)) throw failure('invalid_grant');
          delete store.data.codes[codeHash]; store.save(); return json(200, store.issue(grant));
        }
        if (data.get('grant_type') === 'refresh_token') {
          const key = hash(data.get('refresh_token') || ''), entry = store.data.refresh[key], grant = entry && store.data.grants[entry.grant];
          if (!entry || !grant || entry.expires < Date.now() || grant.expires < Date.now() || grant.client !== data.get('client_id')) throw failure('invalid_grant');
          if (data.has('scope') && data.get('scope') !== 'agent:connect') throw failure('invalid_scope');
          delete store.data.refresh[key]; store.save(); return json(200, store.issue(grant));
        }
        throw failure('unsupported_grant_type');
      }
      if (url.pathname === '/revoke' && req.method === 'POST') {
        const data = new URLSearchParams(await body(req, 8192)), key = hash(data.get('token') || '');
        const entry = store.data.tokens[key] || store.data.refresh[key], grant = entry && store.data.grants[entry.grant];
        if (grant && grant.client === data.get('client_id')) { store.remove(grant.id); await peers.close(grant.id); }
        return json(200, {});
      }
      if (url.pathname === '/.well-known/openai-apps-challenge' && req.method === 'GET' && process.env.VDONINJA_DOMAIN_CHALLENGE) {
        res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(process.env.VDONINJA_DOMAIN_CHALLENGE); return;
      }
      if (url.pathname === '/mcp') {
        let grant;
        try { grant = store.authenticate(/^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1]); }
        catch { res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="agent:connect"`); return json(401, { error: 'invalid_token' }); }
        if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return json(405, { error: 'method_not_allowed' }); }
        const payload = JSON.parse(await body(req, 100000));
        const mcp = hostedTools(grant, peers, store), transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        inflight++;
        res.once('close', () => { inflight--; void mcp.close(); });
        await mcp.connect(transport); await transport.handleRequest(req, res, payload); return;
      }
      if (url.pathname === '/' && req.method === 'GET') {
        res.writeHead(302, { Location: PAGE + 'product.html' }); res.end(); return;
      }
      return json(404, { error: 'not_found' });
    } catch (error) {
      if (!res.headersSent) json(error.status || 400, { error: error.status ? error.message : 'invalid_request' });
      else res.end();
    }
  });
  server.requestTimeout = 65000; server.headersTimeout = 10000; server.maxConnections = 64;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, options.host || process.env.HOST || '127.0.0.1', resolve); });
  return { server, store, peers, async close() { stopping = true; clearInterval(maintenance); await peers.shutdown(); server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); store.save(); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startHosted().then(instance => {
    console.log('VDO.Ninja hosted connector started.');
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void instance.close());
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
