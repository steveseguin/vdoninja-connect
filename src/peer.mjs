import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export class Peer extends EventEmitter {
  constructor({ room, password, streamId, name }) {
    super(); this.config = { room, password, streamId, name }; this.pending = new Map(); this.connected = false;
  }
  async start() {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(NINJA_|OPENAI_API_KEY|CODEX_API_KEY)/i.test(key)));
    env.UV_THREADPOOL_SIZE = '1';
    this.child = fork(fileURLToPath(new URL('./peer-worker.mjs', import.meta.url)), [], {
      env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    this.child.on('message', message => {
      if (message.type === 'sent') { this.pending.get(message.id)?.(message.ok); this.pending.delete(message.id); }
      if (message.type === 'packet') this.emit('packet', message);
      if (message.type === 'network') this.connected = message.connected;
    });
    this.child.on('exit', () => {
      this.connected = false;
      for (const done of this.pending.values()) done(false);
      this.pending.clear(); this.emit('exit');
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('P2P startup timed out')), 30000);
      const finish = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
      this.child.once('error', finish);
      this.child.once('exit', () => finish(new Error('P2P process stopped')));
      this.child.on('message', m => {
        if (m.type === 'ready') { this.connected = true; finish(); }
        if (m.type === 'failed') finish(new Error(m.error));
      });
      this.child.send({ type: 'start', config: this.config });
    }).catch(async error => { await this.close(); throw error; });
  }
  send(target, packet) {
    if (!this.child?.connected) return Promise.resolve(false);
    return new Promise(resolve => {
      const id = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(id); resolve(false); }, 3000);
      this.pending.set(id, ok => { clearTimeout(timer); resolve(ok); });
      this.child.send({ type: 'send', id, target, packet }, error => {
        if (error) { this.pending.get(id)?.(false); this.pending.delete(id); }
      });
    });
  }
  async close() {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { this.child.kill(); resolve(); }, 6000);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
      if (this.child.connected) this.child.send({ type: 'stop' }, () => {});
    });
  }
}
