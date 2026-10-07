import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { initialize, defaultRoot, saveJSON } from './background-state.mjs';
import { BackgroundEngine } from './background-engine.mjs';
import { Peer } from './peer.mjs';

const require = createRequire(import.meta.url);
export async function startBackground(root = defaultRoot(), options = {}) {
  const config = initialize(root);
  const assets = new Map();
  for (const file of ['index.html', 'client.js', 'client.css']) assets.set(file === 'index.html' ? '/' : `/${file}`, readFileSync(new URL(`../client/${file}`, import.meta.url)));
  for (const file of ['secure.mjs', 'connection.mjs']) assets.set(`/${file}`, readFileSync(new URL(file, import.meta.url)));
  assets.set('/sdk.js', readFileSync(require.resolve('@vdoninja/sdk/browser')));
  let peer, engine, stopping = false, traffic = Promise.resolve(), pending = 0, retry;
  const server = http.createServer(async (req, res) => {
    const address = server.address();
    const host = `127.0.0.1:${address.port}`;
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (req.headers.host !== host && req.headers.host !== `localhost:${address.port}`) return json(403, { error: 'Invalid host' });
    const url = new URL(req.url, `http://${host}`);
    if (req.method === 'GET' && assets.has(url.pathname)) {
      const type = url.pathname.endsWith('.css') ? 'text/css' : /\.(m?js)$/.test(url.pathname) ? 'text/javascript' : 'text/html';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' wss://wss.vdo.ninja https://turnservers.vdo.ninja; img-src 'self' blob: data:; media-src 'self' blob:; frame-ancestors 'none'; object-src 'none'; base-uri 'none'" });
      res.end(assets.get(url.pathname)); return;
    }
    const token = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${config.controlToken}`);
    if (req.headers.origin || token.length !== expected.length || !timingSafeEqual(token, expected)) return json(403, { error: 'Local authorization required' });
    if (req.method !== 'POST' || url.pathname !== '/control') return json(404, { error: 'Not found' });
    try {
      let body = '';
      for await (const part of req) { body += part; if (body.length > 16000) throw new Error('Request too large'); }
      const command = JSON.parse(body);
      if (command.op === 'status') return json(200, { running: true, stopping, connected: !!peer?.connected, ...engine.status() });
      if (command.op === 'invite') {
        const invitation = engine.invite(command.name, command.days);
        const fragment = new URLSearchParams({ invitation: JSON.stringify(invitation) });
        return json(200, { peer: invitation.peer, expires: invitation.expires, url: `http://${host}/#${fragment}`,
          web_url: `https://steveseguin.github.io/vdoninja-connect/#${fragment}` });
      }
      if (command.op === 'revoke') { engine.revoke(command.peer); return json(200, { revoked: command.peer }); }
      if (command.op === 'send-file') return json(200, await engine.share(command.peer, command.file));
      if (command.op === 'stop') { json(200, { stopping: true }); setTimeout(() => void close(), 20); return; }
      return json(400, { error: 'Unknown command' });
    } catch (error) { json(400, { error: error.message }); }
  });
  // Bind first: a second daemon cannot touch the first daemon's state.
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', resolve); });
  engine = new BackgroundEngine({ root, config, run: options.run, send: (target, packet) => peer?.send(target, packet) });
  async function connect() {
    if (stopping) return;
    peer = new Peer(config);
    peer.on('packet', message => {
      if (pending >= 100) return;
      pending++;
      traffic = traffic.then(() => engine.receive(message)).catch(() => {}).finally(() => { pending--; });
    });
    peer.once('exit', () => { if (!stopping) retry = setTimeout(() => void connect(), 5000); });
    try { await peer.start(); } catch { /* Exit schedules a bounded restart. */ }
  }
  async function close() {
    if (stopping) return; stopping = true; clearTimeout(retry);
    await traffic; await engine.close(); await peer?.close();
    await new Promise(resolve => server.close(resolve));
    const runtime = path.join(root, 'runtime.json'); if (existsSync(runtime)) unlinkSync(runtime);
    options.onClose?.();
  }
  saveJSON(path.join(root, 'runtime.json'), { pid: process.pid, port: config.port, started: Date.now() });
  void connect();
  return { close, engine, server, config };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startBackground().then(instance => {
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void instance.close());
    console.log(`VDO.Ninja background service: http://127.0.0.1:${instance.config.port}`);
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
