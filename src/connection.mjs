import { seal, unseal, secret, digest, base64, unbase64, CHUNK, MAX_FILE } from './secure.mjs';

// Transport-neutral client: the browser uses the SDK; Node uses the peer worker.
export class Connection {
  constructor(credentials, send, save = () => {}) {
    this.credentials = credentials; this.send = send; this.save = save;
    this.waiting = new Map(); this.onResult = () => {};
  }
  async receive(packet) {
    if (packet?.peer !== this.credentials.peer) return;
    let result;
    try { result = await unseal(this.credentials.nextKey || this.credentials.key, packet, this.credentials.service, 'reply'); }
    catch { return; }
    this.waiting.get(result.id)?.(result);
    this.onResult(result);
  }
  async exchange(packet, id, timeout = 30000) {
    const deadline = Date.now() + timeout;
    return new Promise((resolve, reject) => {
      let timer;
      const finish = result => {
        clearTimeout(timer); this.waiting.delete(id);
        result.status === 'error' ? reject(new Error(result.text)) : resolve(result);
      };
      this.waiting.set(id, finish);
      const attempt = async () => {
        if (!this.waiting.has(id)) return;
        if (Date.now() > deadline) { this.waiting.delete(id); reject(new Error(`Connection timed out. Request ID: ${id}. Reconnect and check status before resending.`)); return; }
        try { await this.send(packet); } catch { /* Retry this identity, never invent a new task. */ }
        if (this.waiting.has(id)) timer = setTimeout(attempt, 1500);
      };
      void attempt();
    });
  }
  async pair() {
    const c = this.credentials;
    if (c.paired) return;
    if (!c.pairPacket) {
      c.nextKey = secret(); c.pairID = crypto.randomUUID();
      c.pairPacket = await seal(c.key, c.peer, c.service, 'request', { op: 'pair', id: c.pairID, ts: Date.now(), key: c.nextKey });
      await this.save(c); // Persist the replacement before consuming the invitation.
    }
    await this.exchange(c.pairPacket, c.pairID);
    c.key = c.nextKey; c.paired = true; delete c.nextKey; delete c.pairID; delete c.pairPacket;
    await this.save(c);
  }
  async request(op, args = {}, id = crypto.randomUUID()) {
    if (!this.credentials.paired) throw new Error('Pair before sending requests.');
    const c = this.credentials;
    const packet = await seal(c.key, c.peer, c.service, 'request', { ...args, op, id, ts: Date.now() });
    return this.exchange(packet, id);
  }
  async upload(bytes, name, mime = '') {
    if (bytes.length > MAX_FILE) throw new Error('Maximum file size is 8 MiB.');
    const file = crypto.randomUUID();
    await this.request('file_begin', { file, name, mime, size: bytes.length, sha256: await digest(bytes) });
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      await this.request('file_chunk', { file, offset, data: base64(bytes.subarray(offset, offset + CHUNK)) });
    }
    await this.request('file_end', { file });
    return file;
  }
  async download(file) {
    let offset = 0, info, bytes;
    do {
      const result = await this.request('file_get', { file, offset });
      if (!info) { info = result; if (info.size > MAX_FILE) throw new Error('File too large'); bytes = new Uint8Array(info.size); }
      if (result.size !== info.size || result.sha256 !== info.sha256) throw new Error('File changed during download');
      const chunk = unbase64(result.data);
      if ((chunk.length === 0 && offset < info.size) || offset + chunk.length > info.size) throw new Error('Invalid file chunk');
      bytes.set(chunk, offset); offset += chunk.length;
    } while (offset < info.size);
    if (await digest(bytes) !== info.sha256) throw new Error('Download checksum mismatch');
    return { bytes, name: info.name, mime: info.mime };
  }
  close() {
    for (const done of this.waiting.values()) done({ status: 'error', text: 'Connection closed' });
    this.waiting.clear();
  }
}
