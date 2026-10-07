import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const project = fileURLToPath(new URL('../', import.meta.url));
export async function serveCompanion({ port = 8791 } = {}) {
  const dashboard = await readFile(require.resolve('@vdoninja/ninja-p2p/dashboard.html'), 'utf8');
  const upstreamScript = '<script src="https://cdn.jsdelivr.net/gh/steveseguin/ninjasdk@v1.5.4/vdoninja-sdk.min.js"></script>';
  if (!dashboard.includes(upstreamScript)) throw new Error('Dashboard dependency changed. Review the SDK asset mapping before serving.');
  // Serve the locked, local SDK rather than fetching executable code from a CDN.
  const routes = new Map([
    ['/', { type: 'text/html', body: await readFile(path.join(project, 'companion/index.html')) }],
    ['/companion.css', { type: 'text/css', body: await readFile(path.join(project, 'companion/companion.css')) }],
    ['/companion.js', { type: 'text/javascript', body: await readFile(path.join(project, 'companion/companion.js')) }],
    ['/dashboard.html', { type: 'text/html', body: dashboard.replace(upstreamScript, '<script src="/sdk.js"></script>') }],
    ['/sdk.js', { type: 'text/javascript', body: await readFile(require.resolve('@vdoninja/sdk/browser')) }]
  ]);
  const server = http.createServer((req, res) => {
    const actualPort = server.address().port;
    if (![ `127.0.0.1:${actualPort}`, `localhost:${actualPort}` ].includes(req.headers.host)) {
      res.writeHead(403); res.end('Invalid host'); return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    const url = new URL(req.url, 'http://127.0.0.1');
    const asset = routes.get(url.pathname);
    if (!asset) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': `${asset.type}; charset=utf-8`, 'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss://wss.vdo.ninja https://turnservers.vdo.ninja; img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'none'"
    });
    res.end(req.method === 'HEAD' ? undefined : asset.body);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const instance = await serveCompanion();
  console.log(`VDO.Ninja Connect companion: ${instance.url}`);
  console.log('Local computer only. Paste the invitation from your agent. Ctrl+C stops the companion.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void instance.close());
}
