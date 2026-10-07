// A separate native-WebRTC process, owned by one MCP connection.
// Parent IPC closure also terminates it if the MCP host exits unexpectedly.
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  process.emit('SIGTERM');
  setTimeout(() => process.exit(0), 2500).unref();
}
process.on('disconnect', stop);
process.on('message', async message => {
  if (message.type === 'stop') return stop();
  if (message.type !== 'start' || process.env.VDO_SIDECAR_STARTED) return;
  process.env.VDO_SIDECAR_STARTED = '1';
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('@vdoninja/ninja-p2p/package.json');
    const pkg = require(pkgPath);
    const cliPath = resolve(dirname(pkgPath), pkg.bin['ninja-p2p']);
    process.argv = [process.execPath, cliPath, 'agent', ...message.args];
    await import(pathToFileURL(cliPath).href);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
});
