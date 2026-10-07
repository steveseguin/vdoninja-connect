import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BackgroundEngine } from '../src/background-engine.mjs';
import { secret, seal, unseal } from '../src/secure.mjs';

async function fixture(t, { dailyTokens, usage }) {
  const root = await mkdtemp(path.join(tmpdir(), 'vdoninja-connect-budget-'));
  let release;
  const firstTurn = new Promise(resolve => { release = resolve; });
  const calls = [], replies = [];
  const engine = new BackgroundEngine({
    root,
    config: { room: 'test-room', password: 'fixture', streamId: 'test-service', dailyTurns: 120, dailyTokens },
    send: async (target, packet) => { replies.push(packet); return true; },
    run: async ({ prompt }) => {
      calls.push(prompt);
      if (calls.length === 1) await firstTurn;
      return { text: 'Fixture reply', usage };
    }
  });
  t.after(async () => { release(); await engine.close(); await rm(root, { recursive: true, force: true }); });
  async function pairedPeer() {
    const invitation = engine.invite(`Device ${Object.keys(engine.state.peers).length + 1}`);
    const key = secret();
    await engine.receive({ from: 'test-client', packet: await seal(invitation.key, invitation.peer, invitation.service, 'request', {
      op: 'pair', id: crypto.randomUUID(), ts: Date.now(), key
    }) });
    return { ...invitation, key };
  }
  async function ask(peer, text) {
    const id = crypto.randomUUID();
    await engine.receive({ from: 'test-client', packet: await seal(peer.key, peer.peer, peer.service, 'request', {
      op: 'ask', id, ts: Date.now(), text
    }) });
    return { id, record: engine.state.requests[`${peer.peer}:${id}`] };
  }
  async function drain() {
    release();
    const deadline = performance.now() + 2000;
    while (engine.active || engine.queue.length) {
      assert.ok(performance.now() < deadline, 'The request queue must drain');
      await delay(1);
    }
  }
  return { engine, root, calls, replies, pairedPeer, ask, drain, release };
}

for (const usage of [{ input_tokens: 6, output_tokens: 4 }, { input_tokens: 6, output_tokens: 6 }]) {
  test(`queued turns stop once completed usage reaches the daily token budget (${usage.input_tokens + usage.output_tokens} tokens)`, async t => {
    const f = await fixture(t, { dailyTokens: 10, usage });
    const activePeer = await f.pairedPeer();
    const first = await f.ask(activePeer, 'Active request');
    const queued = [];
    for (let i = 0; i < 8; i++) {
      const peer = await f.pairedPeer();
      queued.push({ peer, ...await f.ask(peer, `Queued request ${i}`) });
    }
    assert.equal(f.engine.queue.length, 8);
    assert.equal(first.record.status, 'running');
    assert.ok(queued.every(({ record }) => record.status === 'queued'));
    await f.drain();
    assert.deepEqual(f.calls, ['Active request']);
    assert.equal(first.record.status, 'done');
    assert.equal(f.engine.state.budget.tokens, usage.input_tokens + usage.output_tokens);
    for (const { peer, id, record } of queued) {
      assert.equal(record.status, 'error');
      assert.equal(record.text, 'Daily model budget reached.');
      assert.equal(record.request, undefined);
      const packet = f.replies.filter(packet => packet.peer === peer.peer).at(-1);
      const result = await unseal(peer.key, packet, peer.service, 'reply');
      assert.equal(result.id, id);
      assert.equal(result.status, 'error');
      assert.equal(result.text, 'Daily model budget reached.');
    }
    const saved = JSON.parse(await readFile(path.join(f.root, 'state.json'), 'utf8'));
    assert.ok(queued.every(({ peer, id }) => saved.requests[`${peer.peer}:${id}`].status === 'error'));
  });
}

test('queued turns still execute while the daily token budget remains available', async t => {
  const f = await fixture(t, { dailyTokens: 10, usage: { input_tokens: 2, output_tokens: 2 } });
  const first = await f.ask(await f.pairedPeer(), 'First request');
  const second = await f.ask(await f.pairedPeer(), 'Queued request');
  assert.equal(second.record.status, 'queued');
  await f.drain();
  assert.deepEqual(f.calls, ['First request', 'Queued request']);
  assert.equal(first.record.status, 'done');
  assert.equal(second.record.status, 'done');
  assert.equal(f.engine.state.budget.tokens, 8);
});

test('a queued turn can start on a new UTC day after the previous day exhausted its budget', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-07T23:59:59Z') });
  const f = await fixture(t, { dailyTokens: 10, usage: { input_tokens: 6, output_tokens: 4 } });
  const firstPeer = await f.pairedPeer();
  await f.ask(firstPeer, 'Previous day request');
  const second = await f.ask(await f.pairedPeer(), 'New day request');
  let finished, resume;
  const firstFinished = new Promise(resolve => { finished = resolve; });
  const replyReleased = new Promise(resolve => { resume = resolve; });
  const send = f.engine.send;
  f.engine.send = async (target, packet) => {
    if (packet.peer === firstPeer.peer) {
      const result = await unseal(firstPeer.key, packet, firstPeer.service, 'reply');
      if (result.status === 'done') { finished(); await replyReleased; }
    }
    return send(target, packet);
  };
  try {
    f.release();
    await firstFinished;
    assert.equal(f.engine.state.budget.tokens, 10);
    t.mock.timers.setTime(Date.parse('2026-10-08T00:00:01Z'));
    resume();
    await f.drain();
    assert.deepEqual(f.calls, ['Previous day request', 'New day request']);
    assert.equal(second.record.status, 'done');
    assert.equal(f.engine.state.budget.day, '2026-10-08');
    assert.equal(f.engine.state.budget.tokens, 10);
  } finally { resume(); }
});

test('a turn finishing after UTC midnight reports its usage against the new day before the next turn starts', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-07T23:59:59Z') });
  const f = await fixture(t, { dailyTokens: 10, usage: { input_tokens: 6, output_tokens: 4 } });
  const first = await f.ask(await f.pairedPeer(), 'Cross-midnight request');
  const second = await f.ask(await f.pairedPeer(), 'Queued request');
  t.mock.timers.setTime(Date.parse('2026-10-08T00:00:01Z'));
  await f.drain();
  assert.deepEqual(f.calls, ['Cross-midnight request']);
  assert.equal(first.record.status, 'done');
  assert.equal(second.record.status, 'error');
  assert.equal(f.engine.state.budget.day, '2026-10-08');
  assert.equal(f.engine.state.budget.tokens, 10);
});
