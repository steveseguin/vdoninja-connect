import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { roomCredentials } from './invitations.mjs';
import { secret } from './secure.mjs';

export const defaultRoot = () => path.resolve(process.env.VDONINJA_BACKGROUND_DATA || path.join(homedir(), '.vdoninja-connect/background'));
export function readJSON(file) { return JSON.parse(readFileSync(file, 'utf8')); }
export function saveJSON(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  renameSync(temp, file);
}
export function initialize(root = defaultRoot()) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const filename = path.join(root, 'config.json');
  if (!existsSync(filename)) {
    const config = { version: 1, ...roomCredentials(), streamId: `dot_${randomUUID().replaceAll('-', '')}`,
      controlToken: secret(), port: 8792, dailyTurns: 120, dailyTokens: 1000000 };
    // Exclusive creation prevents concurrent starts from replacing identity.
    try { writeFileSync(filename, JSON.stringify(config), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  return readJSON(filename);
}
