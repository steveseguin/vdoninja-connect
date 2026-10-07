import test from 'node:test';
import assert from 'node:assert/strict';
import { HostedPeers } from '../src/hosted-peer.mjs';

const task = { request_key: 'request_123', message: 'Make a checklist', attachment_ids: [] };
function fixture() {
  const grant = { id: 'test-grant', requests: {}, credentials: {} };
  const saved = [], calls = [], remote = new Map();
  const store = { save() { saved.push(structuredClone(grant.requests)); } };
  const peers = new HostedPeers(store, 4);
  const client = { async request(op, args, id) {
    calls.push({ op, args, id });
    if (op === 'ask') { remote.set(id, { status: 'queued' }); return { status: 'queued' }; }
    return remote.get(args.request) || { status: 'unknown' };
  } };
  const entry = { client, used: Date.now(), busy: false };
  entry.ready = Promise.resolve(entry);
  const connect = () => peers.entries.set(grant.id, entry);
  connect();
  return { grant, saved, calls, remote, peers, entry, connect };
}

test('busy admission rejects without reserving a request and identical retry sends it', async () => {
  const f = fixture();
  let release;
  const busy = f.peers.use(f.grant, () => new Promise(resolve => { release = resolve; }));
  await Promise.resolve();
  await assert.rejects(f.peers.ask(f.grant, task), /Another request/);
  assert.equal(f.calls.length, 0);
  assert.equal(Object.keys(f.grant.requests).length, 0);
  assert.equal(f.saved.length, 0);
  release(); await busy;
  assert.equal((await f.peers.ask(f.grant, task)).status, 'queued');
  assert.deepEqual(f.calls.map(c => c.op), ['ask']);
});

test('capacity admission rejects without reserving a request and retry sends it', async () => {
  const f = fixture(); f.peers.entries.clear(); f.peers.maxPeers = 0;
  await assert.rejects(f.peers.ask(f.grant, task), /capacity/);
  assert.equal(Object.keys(f.grant.requests).length, 0);
  assert.equal(f.saved.length, 0);
  f.connect();
  assert.equal((await f.peers.ask(f.grant, task)).status, 'queued');
  assert.deepEqual(f.calls.map(c => c.op), ['ask']);
});

test('stopping admission rejects without reserving a request', async () => {
  const f = fixture(); f.peers.closing = true;
  await assert.rejects(f.peers.ask(f.grant, task), /stopping/);
  assert.equal(Object.keys(f.grant.requests).length, 0);
  f.peers.closing = false;
  assert.equal((await f.peers.ask(f.grant, task)).status, 'queued');
});

test('failed ready promise rejects before reservation and can be retried', async () => {
  const f = fixture(); f.entry.ready = Promise.reject(new Error('could not pair'));
  await assert.rejects(f.peers.ask(f.grant, task), /could not pair/);
  assert.equal(Object.keys(f.grant.requests).length, 0);
  f.entry.ready = Promise.resolve(f.entry);
  assert.equal((await f.peers.ask(f.grant, task)).status, 'queued');
});

test('a request is persisted before its client handoff', async () => {
  const f = fixture();
  f.entry.client.request = async (op, args, id) => {
    assert.equal(op, 'ask'); assert.equal(f.saved.length, 1);
    assert.ok(f.saved[0][id]); return { status: 'queued' };
  };
  assert.equal((await f.peers.ask(f.grant, task)).status, 'queued');
});

test('uncertain client failure remains status-only on retry', async () => {
  const f = fixture(); let first = true;
  f.entry.client.request = async (op, args, id) => {
    f.calls.push({ op, args, id });
    if (first) { first = false; throw new Error('reply timed out'); }
    assert.equal(op, 'status'); return { status: 'unknown' };
  };
  await assert.rejects(f.peers.ask(f.grant, task), /timed out/);
  assert.equal(Object.keys(f.grant.requests).length, 1);
  assert.equal((await f.peers.ask(f.grant, task)).status, 'unknown');
  assert.deepEqual(f.calls.map(c => c.op), ['ask', 'status']);
  assert.equal(f.saved.length, 1);
});

test('successful repeated request reads existing state and never repeats the turn', async () => {
  const f = fixture(); const first = await f.peers.ask(f.grant, task);
  f.remote.set(first.request_id, { status: 'done', text: 'Checklist ready' });
  assert.deepEqual(await f.peers.ask(f.grant, task), { request_id: first.request_id, status: 'done', text: 'Checklist ready' });
  assert.deepEqual(f.calls.map(c => c.op), ['ask', 'status']);
  assert.equal(f.saved.length, 1);
});

test('different content under a reserved key is rejected', async () => {
  const f = fixture(); await f.peers.ask(f.grant, task);
  await assert.rejects(f.peers.ask(f.grant, { ...task, message: 'Different task' }), /different content/);
  assert.deepEqual(f.calls.map(c => c.op), ['ask']);
});

test('request cap blocks new work but permits reading previously accepted work', async () => {
  const f = fixture(); const first = await f.peers.ask(f.grant, task);
  for (let i = 1; i < 200; i++) f.grant.requests[`record-${i}`] = { fingerprint: 'old' };
  await assert.rejects(f.peers.ask(f.grant, { ...task, request_key: 'new_request' }), /200-request limit/);
  assert.equal((await f.peers.ask(f.grant, task)).request_id, first.request_id);
  assert.deepEqual(f.calls.map(c => c.op), ['ask', 'status']);
});

test('overlapping identical requests preserve the first handoff and one identity', async () => {
  const f = fixture(); let release;
  f.entry.client.request = async (op, args, id) => {
    f.calls.push({ op, args, id });
    if (op === 'ask') return new Promise(resolve => { release = () => resolve({ status: 'queued' }); });
    return { status: 'queued' };
  };
  const first = f.peers.ask(f.grant, task); await Promise.resolve(); await Promise.resolve();
  await assert.rejects(f.peers.ask(f.grant, task), /Another request/);
  release(); await first;
  assert.equal((await f.peers.ask(f.grant, task)).status, 'queued');
  assert.deepEqual(f.calls.map(c => c.op), ['ask', 'status']);
  assert.equal(Object.keys(f.grant.requests).length, 1);
  assert.equal(f.saved.length, 1);
});
