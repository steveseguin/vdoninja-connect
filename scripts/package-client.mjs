import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(import.meta.url);
const root = new URL('../', import.meta.url);
const pages = process.argv.includes('--pages');
const output = pages ? fileURLToPath(new URL('docs/', root)) : path.resolve(process.env.VDONINJA_PACKAGE_DIR || path.join(homedir(), '.codex/artifacts/vdoninja-connect'));
await mkdir(output, { recursive: true });
let html = await readFile(new URL('client/index.html', root), 'utf8');
const css = await readFile(new URL('client/client.css', root), 'utf8');
const sdk = await readFile(require.resolve('@vdoninja/sdk/browser'), 'utf8');
let script = '';
for (const file of ['src/secure.mjs', 'src/connection.mjs', 'client/client.js']) {
  script += '\n' + (await readFile(new URL(file, root), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
}
html = html.replace('<link rel="stylesheet" href="/client.css">', () => `<style>${css}</style>`)
  .replace('<script src="/sdk.js"></script>', () => `<script>${sdk.replace(/<\/script/gi, '<\\/script')}</script>`)
  .replace('<script type="module" src="/client.js"></script>', () => `<script type="module">${script.replace(/<\/script/gi, '<\\/script')}</script>`);
const sdkLicense = await readFile(path.join(path.dirname(require.resolve('@vdoninja/sdk/browser')), 'LICENSE'), 'utf8');
html = html.replace('</head>', () => `<!-- Bundled @vdoninja/sdk 1.6.1, Mozilla Public License 2.0. Source: https://github.com/steveseguin/ninjasdk/tree/v1.6.1\n${sdkLicense.replaceAll('--', '—')}\n-->\n</head>`);
const target = path.join(output, pages ? 'index.html' : 'vdoninja-connect.html');
await writeFile(target, html);
if (pages) await writeFile(path.join(output, '.nojekyll'), '');
console.log(target);
