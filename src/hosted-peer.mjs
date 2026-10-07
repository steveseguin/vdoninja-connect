import { randomUUID } from 'node:crypto';
import { Peer } from './peer.mjs';
import { Connection } from './connection.mjs';
import { hash } from './hosted-store.mjs';

export class HostedPeers {
  constructor(store, maxPeers) { this.store = store; this.maxPeers = maxPeers; this.entries = new Map(); this.closing = false; }
  async open(grant) {
    if (this.closing) throw new Error('Service is stopping. Try again later.');
    const existing = this.entries.get(grant.id);
    if (existing) { existing.used = Date.now(); return existing.ready; }
    if (this.entries.size >= this.maxPeers) throw new Error('Service connection capacity reached. Try again later.');
    const c = grant.credentials;
    const peer = new Peer({ room: c.room, password: c.password, streamId: `host_${randomUUID().replaceAll('-', '')}`, name: 'Authorized connector' });
    const client = new Connection(c, packet => peer.send(c.service, packet), credentials => {
      grant.credentials = credentials; this.store.save();
    });
    const entry = { peer, client, used: Date.now(), busy: false, ready: null };
    this.entries.set(grant.id, entry);
    peer.on('packet', ({ packet }) => void client.receive(packet));
    entry.ready = (async () => {
      try { await peer.start(); await client.pair(); return entry; }
      catch (error) { await this.close(grant.id); throw new Error('Could not reach or pair with the agent. Keep it running and use a fresh invitation if this invitation has already been consumed.'); }
    })();
    return entry.ready;
  }
  async use(grant, fn) {
    const entry = await this.open(grant);
    if (entry.busy) throw new Error('Another request is using this connection. Retry after it completes.');
    entry.busy = true; entry.used = Date.now();
    try { return await fn(entry.client); }
    finally { entry.busy = false; entry.used = Date.now(); }
  }
  async ask(grant, { request_key, message, attachment_ids = [] }) {
    const id = hash(`${grant.id}:${request_key}`);
    const fingerprint = hash(JSON.stringify({ message, attachment_ids }));
    const prior = grant.requests[id];
    if (prior && prior.fingerprint !== fingerprint) throw new Error('This request key was already used for different content. Choose a new key.');
    if (prior) return { request_id: id, ...(await this.use(grant, c => c.request('status', { request: id }))) };
    if (Object.keys(grant.requests).length >= 200) throw new Error('This connection has reached its 200-request limit. Revoke it and authorize a fresh invitation.');
    grant.requests[id] = { fingerprint, created: Date.now() }; this.store.save();
    // Persist before the network call. A timeout never silently queues a second turn.
    return { request_id: id, ...(await this.use(grant, c => c.request('ask', { text: message, attachments: attachment_ids }, id))) };
  }
  async close(id) {
    const entry = this.entries.get(id); if (!entry) return;
    this.entries.delete(id); entry.client.close(); await entry.peer.close();
  }
  async sweep() {
    for (const [id, entry] of this.entries) if (!entry.busy && Date.now() - entry.used > 120000) await this.close(id);
  }
  async shutdown() { this.closing = true; for (const id of [...this.entries.keys()]) await this.close(id); }
}
