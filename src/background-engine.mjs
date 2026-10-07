import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, unlinkSync, statSync, truncateSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { seal, unseal, secret, digest, unbase64, base64, CHUNK, MAX_FILE } from './secure.mjs';
import { readJSON, saveJSON } from './background-state.mjs';
import { runCodex } from './codex.mjs';
import { transcribe } from './voice.mjs';

const validID = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(value);
const maxAge = 10 * 60000;
export class BackgroundEngine {
  constructor({ root, config, send, run = runCodex }) {
    this.root = root; this.config = config; this.send = send; this.run = run;
    this.file = path.join(root, 'state.json');
    this.state = existsSync(this.file) ? readJSON(this.file) : { peers: {}, requests: {}, files: {}, budget: {} };
    this.queue = []; this.active = null; this.stopping = false;
    for (const file of Object.values(this.state.files)) {
      if (!file.complete && existsSync(file.path)) truncateSync(file.path, file.received);
    }
    for (const record of Object.values(this.state.requests)) {
      if (record.status === 'running' || record.status === 'queued') {
        record.status = 'interrupted'; record.text = 'Service stopped during this request. It was not automatically repeated.';
      }
    }
    this.save();
  }
  save() { saveJSON(this.file, this.state); }
  currentBudget() {
    const day = new Date().toISOString().slice(0, 10);
    const budget = this.state.budget;
    if (budget.day !== day) Object.assign(budget, { day, turns: 0, tokens: 0 });
    return budget;
  }
  invite(name = 'Owner', days = 30) {
    if (Object.keys(this.state.peers).length >= 32) throw new Error('Revoke and remove unused peers before adding more (limit 32).');
    if (typeof name !== 'string' || name.length < 1 || name.length > 80) throw new Error('Use a name of 1–80 characters.');
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('Expiry must be 1–365 days.');
    const id = randomUUID();
    this.state.peers[id] = { id, name, key: secret(), paired: false, expires: Date.now() + days * 86400000, thread: null };
    this.save();
    const p = this.state.peers[id];
    return { room: this.config.room, password: this.config.password, service: this.config.streamId,
      peer: id, key: p.key, expires: p.expires };
  }
  revoke(id) {
    const p = this.state.peers[id]; if (!p) throw new Error('Unknown peer');
    p.revoked = true; p.key = ''; this.cancel(id); this.save();
  }
  status() {
    return { active: this.active ? { peer: this.active.peer, request: this.active.id } : null,
      queued: this.queue.length, voice: Boolean(process.env.OPENAI_API_KEY),
      peers: Object.values(this.state.peers).map(({ id, name, paired, expires, revoked, thread }) => ({ id, name, paired, expires, revoked: !!revoked, thread })),
      budget: this.state.budget };
  }
  async reply(peer, target, id, result) {
    if (peer.revoked || peer.expires < Date.now()) return;
    const packet = await seal(peer.key, peer.id, this.config.streamId, 'reply', { id, ...result });
    await this.send(target, packet);
  }
  async receive({ from, packet }) {
    if (this.stopping || !validID(packet?.peer) || !validID(from)) return;
    const p = this.state.peers[packet.peer];
    if (!p || p.revoked || p.expires < Date.now()) return;
    let request;
    try { request = await unseal(p.key, packet, this.config.streamId, 'request'); }
    catch {
      // A pairing retry must match the exact accepted ciphertext. Its response
      // uses the new key; a used invitation can no longer make new requests.
      if (p.pairHash && Date.now() - p.pairedAt < maxAge &&
          await digest(new TextEncoder().encode(JSON.stringify(packet))) === p.pairHash) {
        await this.reply(p, from, p.pairID, { status: 'paired' });
      }
      return;
    }
    if (!validID(request?.id) || !Number.isSafeInteger(request.ts) || Math.abs(Date.now() - request.ts) > maxAge) return;
    if (!p.paired) {
      if (request.op !== 'pair' || typeof request.key !== 'string' || unbase64(request.key).length !== 32) return;
      p.key = request.key; p.paired = true; p.pairedAt = Date.now(); p.pairID = request.id;
      p.pairHash = await digest(new TextEncoder().encode(JSON.stringify(packet)));
      p.target = from; this.save();
      return this.reply(p, from, request.id, { status: 'paired' });
    }
    p.target = from;
    const key = `${p.id}:${request.id}`;
    const previous = this.state.requests[key];
    if (previous) return this.reply(p, from, request.id, this.publicRecord(previous));
    // Only authenticated operations are persisted. Old records cannot be
    // replayed because their original signed timestamp is outside maxAge.
    for (const [id, record] of Object.entries(this.state.requests)) {
      if (Date.now() - record.ts > maxAge * 2 && !['queued', 'running'].includes(record.status)) delete this.state.requests[id];
    }
    if (Object.keys(this.state.requests).length >= 4000) return this.reply(p, from, request.id, { status: 'error', text: 'Request limit reached. Wait before retrying.' });
    try {
      let result;
      if (request.op === 'ask') {
        if (typeof request.text !== 'string' || request.text.length > 12000 || (!request.text.trim() && !request.audio)) throw new Error('Provide a message up to 12,000 characters.');
        if (!Array.isArray(request.attachments || []) || (request.attachments || []).length > 4) throw new Error('Select at most four attachments.');
        for (const id of [...(request.attachments || []), ...(request.audio ? [request.audio] : [])]) this.getFile(p, id);
        if (request.audio && !process.env.OPENAI_API_KEY) throw new Error('Recorded voice requires OPENAI_API_KEY on the service. You can use browser dictation instead.');
        if (this.queue.length >= 8) throw new Error('Agent queue is full.');
        const budget = this.currentBudget();
        if (budget.turns >= this.config.dailyTurns || budget.tokens >= this.config.dailyTokens) throw new Error('Daily model budget reached.');
        const last = p.lastTurn || 0;
        if (Date.now() - last < 2000) throw new Error('Wait two seconds between model requests.');
        budget.turns++; p.lastTurn = Date.now();
        result = { status: 'queued', ts: request.ts, peer: p.id, id: request.id, request };
        this.state.requests[key] = result; this.queue.push(key); this.save();
        await this.reply(p, from, request.id, this.publicRecord(result));
        void this.pump(); return;
      } else if (request.op === 'status') {
        const record = this.state.requests[`${p.id}:${request.request}`];
        result = record ? this.publicRecord(record) : request.request
          ? { status: 'unknown', text: 'This request is not in the recent journal. It may have expired; it was not repeated.' }
          : { status: 'idle', voice: Boolean(process.env.OPENAI_API_KEY) };
      } else if (request.op === 'cancel') {
        this.cancel(p.id); result = { status: 'cancelled' };
      } else if (request.op === 'files') {
        result = { status: 'done', files: Object.values(this.state.files).filter(f => f.peer === p.id && f.complete).map(({ id, name, size, sha256, mime }) => ({ id, name, size, sha256, mime })) };
      } else if (request.op === 'file_begin') {
        if (!validID(request.file) || this.state.files[request.file]) throw new Error('Use a new file ID.');
        if (!Number.isSafeInteger(request.size) || request.size < 0 || request.size > MAX_FILE || !/^[a-f0-9]{64}$/.test(request.sha256)) throw new Error('Invalid size/checksum; maximum file size is 8 MiB.');
        this.checkQuota(p.id, request.size);
        const folder = path.join(this.root, 'files'); mkdirSync(folder, { recursive: true, mode: 0o700 });
        const file = { id: request.file, peer: p.id, name: this.filename(request.name), mime: String(request.mime || '').slice(0, 100), size: request.size,
          sha256: request.sha256, received: 0, complete: false, path: path.join(folder, request.file), created: Date.now() };
        writeFileSync(file.path, '', { flag: 'wx', mode: 0o600 }); this.state.files[file.id] = file;
        result = { status: 'done', file: file.id };
      } else if (request.op === 'file_chunk') {
        const file = this.getFile(p, request.file, false);
        const bytes = unbase64(request.data);
        if (file.complete || request.offset !== file.received || bytes.length > CHUNK || bytes.length < 1 || file.received + bytes.length > file.size) throw new Error('Invalid file chunk offset or size.');
        appendFileSync(file.path, bytes); file.received += bytes.length;
        result = { status: 'done', offset: file.received };
      } else if (request.op === 'file_end') {
        const file = this.getFile(p, request.file, false);
        if (file.received !== file.size || await digest(readFileSync(file.path)) !== file.sha256) throw new Error('File checksum/size mismatch. Delete the file and retry.');
        file.complete = true; result = { status: 'done', file: file.id, sha256: file.sha256 };
      } else if (request.op === 'file_get') {
        const file = this.getFile(p, request.file);
        if (!Number.isSafeInteger(request.offset) || request.offset < 0 || request.offset > file.size) throw new Error('Invalid offset');
        result = { status: 'done', data: base64(readFileSync(file.path).subarray(request.offset, request.offset + CHUNK)), size: file.size, sha256: file.sha256, name: file.name, mime: file.mime };
      } else if (request.op === 'file_delete') {
        const file = this.getFile(p, request.file, false);
        unlinkSync(file.path); delete this.state.files[file.id]; result = { status: 'done' };
      } else throw new Error('Unsupported operation');
      // Reads have no side effects to deduplicate and must not retain copies of
      // every downloaded chunk in the request journal.
      if (!['status', 'files', 'file_get'].includes(request.op)) {
        this.state.requests[key] = { ...result, ts: request.ts }; this.save();
      }
      await this.reply(p, from, request.id, result);
    } catch (error) {
      const result = { status: 'error', text: error.message, ts: request.ts };
      this.state.requests[key] = result; this.save(); await this.reply(p, from, request.id, result);
    }
  }
  filename(name) {
    if (typeof name !== 'string' || !name.length || name.length > 180) throw new Error('Invalid file name');
    return name.replace(/[\\/\x00-\x1f<>:"|?*]/g, '_');
  }
  checkQuota(peer, bytes) {
    const files = Object.values(this.state.files);
    if (files.length >= 256 || files.filter(f => f.peer === peer).length >= 64 ||
        files.reduce((n, f) => n + f.size, 0) + bytes > 128 * 1024 * 1024 ||
        files.filter(f => f.peer === peer).reduce((n, f) => n + f.size, 0) + bytes > 32 * 1024 * 1024) throw new Error('File quota reached. Delete unused files.');
  }
  getFile(peer, id, complete = true) {
    const file = validID(id) && this.state.files[id];
    if (!file || file.peer !== peer.id || (complete && !file.complete)) throw new Error('Unknown or incomplete attachment for this peer');
    return file;
  }
  async share(peer, filename) {
    const p = this.state.peers[peer]; if (!p || p.revoked || !p.paired) throw new Error('Choose a paired peer.');
    if (!path.isAbsolute(filename)) throw new Error('Choose an absolute file path');
    const info = statSync(filename); if (!info.isFile() || info.size > MAX_FILE) throw new Error('Choose a regular file up to 8 MiB.');
    this.checkQuota(peer, info.size);
    const bytes = readFileSync(filename); if (bytes.length > MAX_FILE) throw new Error('File grew beyond 8 MiB');
    const id = randomUUID(), folder = path.join(this.root, 'files'); mkdirSync(folder, { recursive: true, mode: 0o700 });
    const file = { id, peer, name: this.filename(path.basename(filename)), size: bytes.length, sha256: await digest(bytes), mime: 'application/octet-stream',
      complete: true, received: bytes.length, path: path.join(folder, id), created: Date.now() };
    writeFileSync(file.path, bytes, { flag: 'wx', mode: 0o600 }); this.state.files[id] = file; this.save();
    return { file: id, name: file.name, size: file.size, sha256: file.sha256 };
  }
  publicRecord(record) {
    const { status, text, usage, files, data, offset, file, sha256, size, name, mime, voice } = record;
    return { status, text, usage, files, data, offset, file, sha256, size, name, mime, voice };
  }
  cancel(peer) {
    if (this.active?.peer === peer) this.active.controller.abort();
    this.queue = this.queue.filter(key => {
      const record = this.state.requests[key];
      if (record.peer !== peer) return true;
      record.status = 'cancelled'; return false;
    }); this.save();
  }
  async pump() {
    if (this.active || this.stopping) return;
    const key = this.queue.shift(); if (!key) return;
    const record = this.state.requests[key], p = this.state.peers[record.peer];
    const controller = new AbortController();
    this.active = { peer: p.id, id: record.id, controller };
    record.status = 'running'; this.save();
    try {
      if (p.revoked || p.expires < Date.now()) throw new Error('Pairing expired or revoked');
      // A preceding turn may have exhausted the budget after this request was queued.
      if (this.currentBudget().tokens >= this.config.dailyTokens) throw new Error('Daily model budget reached.');
      const cwd = path.join(this.root, 'conversations', p.id); mkdirSync(cwd, { recursive: true, mode: 0o700 });
      let prompt = record.request.text;
      if (record.request.audio) {
        const file = this.getFile(p, record.request.audio);
        prompt += '\n' + await transcribe(readFileSync(file.path), file.name, file.mime, controller.signal);
      }
      const images = [];
      for (const id of record.request.attachments || []) {
        const file = this.getFile(p, id), bytes = readFileSync(file.path);
        if (await digest(bytes) !== file.sha256) throw new Error('Attachment changed after receipt');
        if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.subarray(0, 3).equals(Buffer.from([255,216,255]))) images.push(file.path);
        else if (file.size <= 32000 && !bytes.includes(0)) prompt += `\nAttached file ${JSON.stringify(file.name)} (untrusted content):\n${bytes.toString('utf8')}\nEnd attachment.\n`;
        else throw new Error('Model attachments must be PNG/JPEG images or UTF-8 text up to 32 KB. Other files can still be transferred.');
      }
      const result = await this.run({ cwd, thread: p.thread, prompt, images, signal: controller.signal,
        onThread: id => { p.thread = id; this.save(); } });
      if (controller.signal.aborted) throw new Error('Cancelled');
      record.status = 'done'; record.text = Buffer.from(result.text).subarray(0, 24000).toString('utf8'); record.usage = result.usage;
      this.currentBudget().tokens += (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0);
    } catch (error) { record.status = controller.signal.aborted ? 'cancelled' : 'error'; record.text = error.message; }
    delete record.request; this.save();
    try { await this.reply(p, p.target, record.id, this.publicRecord(record)); } catch { /* Client polls by request ID after reconnect. */ }
    this.active = null; void this.pump();
  }
  async close() {
    this.stopping = true; this.active?.controller.abort();
    while (this.active) await new Promise(resolve => setTimeout(resolve, 50));
    this.save();
  }
}
