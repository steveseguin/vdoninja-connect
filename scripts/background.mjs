import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { control } from '../src/background-control.mjs';
import { initialize, defaultRoot } from '../src/background-state.mjs';

const root = defaultRoot();
const [op = 'status', ...args] = process.argv.slice(2);
const service = fileURLToPath(new URL('../src/background.mjs', import.meta.url));
async function main() {
  if (op === 'start') {
    initialize(root);
    try {
      const status = await control({ op: 'status' });
      if (!status.stopping) return console.log(JSON.stringify(status, null, 2));
      for (let i = 0; i < 40; i++) {
        await new Promise(resolve => setTimeout(resolve, 250));
        try { await control({ op: 'status' }); } catch { break; }
      }
    } catch {}
    const log = openSync(path.join(root, 'service.log'), 'a', 0o600);
    const child = spawn(process.execPath, [service], { detached: true, windowsHide: true,
      env: { ...process.env, UV_THREADPOOL_SIZE: '1', RAYON_NUM_THREADS: '1' }, stdio: ['ignore', log, log] });
    closeSync(log); child.unref();
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    for (let i = 0; i < 40; i++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      try { console.log(JSON.stringify(await control({ op: 'status' }), null, 2)); return; } catch {}
    }
    throw new Error(`Startup failed; inspect ${path.join(root, 'service.log')}`);
  }
  if (op === 'startup') {
    if (process.platform !== 'win32') throw new Error('Automatic login startup is currently available on Windows. Use your service manager on other platforms.');
    if (!['enable', 'disable'].includes(args[0])) throw new Error('Use startup enable or startup disable');
    const folder = path.join(process.env.APPDATA, 'Microsoft/Windows/Start Menu/Programs/Startup');
    const target = path.join(folder, 'VDO.Ninja Connect.vbs');
    if (args[0] === 'disable') { if (existsSync(target)) unlinkSync(target); console.log('Login startup disabled.'); return; }
    mkdirSync(folder, { recursive: true });
    const quote = text => text.replaceAll('"', '""');
    const command = `"${process.execPath}" "${service}"`;
    writeFileSync(target, `Set shell = CreateObject("WScript.Shell")\r\nshell.Environment("PROCESS")("VDONINJA_BACKGROUND_DATA") = "${quote(root)}"\r\nshell.Run "${quote(command)}", 0, False\r\n`);
    console.log('Login startup enabled. The service runs hidden while you are signed in.'); return;
  }
  let command;
  if (op === 'invite') command = { op, name: args[0] || 'Owner', days: args[1] ? Number(args[1]) : 30 };
  else if (op === 'revoke') command = { op, peer: args[0] };
  else if (op === 'send-file') command = { op, peer: args[0], file: args[1] };
  else if (['status', 'stop'].includes(op)) command = { op };
  else throw new Error('Commands: start, status, stop, invite [name] [days], revoke <peer>, send-file <peer> <absolute-path>, startup enable|disable');
  const result = await control(command);
  if (op === 'stop') {
    for (let i = 0; i < 50; i++) {
      await new Promise(resolve => setTimeout(resolve, 200));
      try { await control({ op: 'status' }); } catch { console.log('Background service stopped.'); return; }
    }
    throw new Error('Service is still stopping. Check status before starting another copy.');
  }
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
