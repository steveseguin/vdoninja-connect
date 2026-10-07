// Configure only this trusted checkout. Does not edit global Codex settings.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const configDir = path.join(root, '.codex');
const configPath = path.join(configDir, 'config.toml');
const table = '[mcp_servers.vdoninja-connect]';
let existing = '';
try { existing = await readFile(configPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (existing.includes(table)) {
  console.log('This checkout already has a VDO.Ninja Connect MCP entry. No settings changed.');
} else {
  // TOML basic strings use the JSON escaping needed for these local paths.
  const config = `${existing.trimEnd()}\n\n${table}\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(path.join(root, 'src/server.mjs'))}]\nstartup_timeout_sec = 30\ntool_timeout_sec = 45\n`;
  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, config.trimStart(), 'utf8');
  console.log(`Added the local MCP server to ${configPath}`);
}
console.log('Reopen this trusted project in Codex to load the tools. Do not also enable a second copy through the marketplace.');
