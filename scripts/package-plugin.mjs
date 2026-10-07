import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { submissionConfig } from './submission-config.mjs';

// Small, dependency-free ZIP writer using stored entries. Source-only allowlist:
// no node_modules, session records, private configuration or credentials.
const root = fileURLToPath(new URL('../', import.meta.url));
const submission = process.argv.includes('--submission');
const replacements = new Map();
const files = submission ? ['plugin.json', 'mcp.json', 'assets/icon.png', 'skills/use-background-agent/SKILL.md'] : ['package.json', 'package-lock.json', 'plugin.json', 'mcp.json', 'README.md', 'Dockerfile', '.dockerignore'];
if (submission) {
  const { plugin, mcp } = submissionConfig(JSON.parse(await readFile(path.join(root, 'plugin.json'), 'utf8')), process.env.VDONINJA_HOSTED_ORIGIN, process.env.VDONINJA_REVIEW_VIDEO_URL);
  for (const [name, value] of [['plugin.json', plugin], ['mcp.json', mcp]]) replacements.set(name, Buffer.from(JSON.stringify(value, null, 2) + '\n'));
  replacements.set('skills/use-background-agent/SKILL.md', await readFile(path.join(root, 'hosted-plugin/skills/use-background-agent/SKILL.md')));
  const urls = [plugin.extensions['com.openai'].review.demo_recording_url, ...['websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL'].map(key => plugin.extensions['com.openai'].interface[key])];
  for (const url of urls) {
    const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Public submission URL unavailable: ${url}`);
  }
  const challenge = await fetch(mcp.mcpServers['vdoninja-connect'].url, { signal: AbortSignal.timeout(15000) });
  if (challenge.status !== 401 || !challenge.headers.get('www-authenticate')?.includes('resource_metadata=')) throw new Error('Hosted MCP must return its OAuth resource challenge to unauthenticated requests.');
} else {
  for (const dir of ['src', 'scripts', 'companion', 'client', 'skills', 'hosted-plugin', 'assets', 'docs', 'tests', '.agents']) await collect(dir);
}
async function collect(relative) {
  for (const item of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const entry = `${relative}/${item.name}`;
    if (item.isSymbolicLink()) throw new Error(`Refusing symlink: ${entry}`);
    if (item.isDirectory()) await collect(entry);
    else if (item.isFile()) files.push(entry);
  }
}
const table = Array.from({ length: 256 }, (_, n) => {
  let crc = n;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
let offset = 0;
const entries = [];
const central = [];
for (const name of files.sort()) {
  const bytes = replacements.get(name) || await readFile(path.join(root, name));
  const filename = Buffer.from(name);
  const crc = crc32(bytes);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6); header.writeUInt16LE(33, 12);
  header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22);
  header.writeUInt16LE(filename.length, 26);
  entries.push(header, filename, bytes);
  const record = Buffer.alloc(46);
  record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6);
  record.writeUInt16LE(0x0800, 8); record.writeUInt16LE(33, 14);
  record.writeUInt32LE(crc, 16); record.writeUInt32LE(bytes.length, 20); record.writeUInt32LE(bytes.length, 24);
  record.writeUInt16LE(filename.length, 28); record.writeUInt32LE(offset, 42);
  central.push(record, filename);
  offset += header.length + filename.length + bytes.length;
}
const centralBytes = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
const output = path.resolve(process.env.VDONINJA_PACKAGE_DIR || path.join(homedir(), '.codex/artifacts/vdoninja-connect'));
await mkdir(output, { recursive: true });
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const destination = path.join(output, `vdoninja-connect-${submission ? 'submission-' : ''}${version}.zip`);
await writeFile(destination, Buffer.concat([...entries, centralBytes, end]));
console.log(`Packaged ${files.length} ${submission ? 'submission' : 'source'} files: ${destination}`);
