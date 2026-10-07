import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const project = fileURLToPath(new URL('../', import.meta.url));
const testRoot = path.join(project, '.test-state');
await mkdir(testRoot, { recursive: true });
const root = await mkdtemp(path.join(testRoot, 'live-'));
const clients = [];
async function agent(name) {
  const client = new Client({ name, version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(project, 'src/server.mjs')],
    env: { ...process.env, VDONINJA_CONNECT_DATA: path.join(root, name), UV_THREADPOOL_SIZE: '1' }, stderr: 'pipe' });
  clients.push(client);
  await client.connect(transport);
  return client;
}
async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 35000 });
  assert.ok(!result.isError, result.content?.[0]?.text || 'MCP error');
  return result.structuredContent;
}
async function until(label, fn, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(500); }
  throw new Error(`Timed out: ${label}`);
}
try {
  const alice = await agent('Alice');
  const bob = await agent('Bob');
  const a = await call(alice, 'vdo_connect', { name: 'Alice', ttl_minutes: 5 });
  const b = await call(bob, 'vdo_connect', { name: 'Bob', invitation: a.browser_url, ttl_minutes: 5 });
  await until('peer discovery', async () => {
    const state = await call(alice, 'vdo_status', { session_id: a.session_id });
    return state.peers.some(peer => peer.streamId === b.peer_id && peer.connected);
  });
  console.log('PASS: two separate MCP processes discover each other over live WebRTC');
  const isolation = await bob.callTool({ name: 'vdo_status', arguments: { session_id: a.session_id } });
  assert.equal(isolation.isError, true);
  console.log('PASS: cross-client session access rejected');
  const message = await call(alice, 'vdo_send', { session_id: a.session_id, target: b.peer_id, text: 'Live MCP hello' });
  await until('direct message', async () => {
    const inbox = await call(bob, 'vdo_receive', { session_id: b.session_id, peek: true });
    return inbox.messages.find(m => m.id === message.message_id && m.payload?.text === 'Live MCP hello');
  });
  const receipt = await call(alice, 'vdo_receipt', { session_id: a.session_id, message_id: message.message_id, target: b.peer_id });
  // Current ninja-p2p peers do not automatically acknowledge ordinary chat.
  // Never upgrade transport acceptance to an invented delivery confirmation.
  assert.equal(receipt.status, 'unknown');
  console.log('PASS: direct message received; absent acknowledgement remains unknown');
  const request = await call(alice, 'vdo_request', { session_id: a.session_id, target: b.peer_id, request: 'review', data: { fixture: true } });
  await until('request', async () => (await call(bob, 'vdo_receive', { session_id: b.session_id, peek: true })).messages.some(m => m.id === request.message_id));
  await call(bob, 'vdo_respond', { session_id: b.session_id, target: a.peer_id, request_id: request.message_id, result: { reviewed: true } });
  await until('response', async () => (await call(alice, 'vdo_receipt', { session_id: a.session_id, message_id: request.message_id, target: b.peer_id })).status === 'responded');
  console.log('PASS: structured request and correlated response');
  const file = path.join(root, 'handoff.txt');
  const bytes = Buffer.from('VDO.Ninja plugin file handoff\n'.repeat(3000));
  await writeFile(file, bytes);
  await call(alice, 'vdo_send_file', { session_id: a.session_id, target: b.peer_id, file_path: file });
  const received = await until('file transfer', async () => {
    const inbox = await call(bob, 'vdo_receive', { session_id: b.session_id, peek: true });
    return inbox.messages.find(m => m.payload?.kind === 'file_received');
  });
  const saved = received.payload.savedPath;
  assert.ok(saved, JSON.stringify(received.payload));
  assert.equal(createHash('sha256').update(await readFile(saved)).digest('hex'), createHash('sha256').update(bytes).digest('hex'));
  console.log(`PASS: ${bytes.length} byte file transferred and independently hash-verified`);
  await call(alice, 'vdo_disconnect', { session_id: a.session_id });
  assert.equal((await call(alice, 'vdo_status', { session_id: a.session_id })).connected, false);
  console.log('PASS: explicit disconnect');
  console.log('Live checks passed. Local test records: ' + root);
} finally {
  for (const client of clients) await client.close().catch(() => {});
}
