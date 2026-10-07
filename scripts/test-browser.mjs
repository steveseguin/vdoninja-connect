import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Rooms } from '../src/rooms.mjs';
import { serveCompanion } from './serve-companion.mjs';

await mkdir('.test-state', { recursive: true });
await mkdir('artifacts/screenshots', { recursive: true });
const root = await mkdtemp(path.resolve('.test-state/browser-'));
const rooms = new Rooms({ root });
const web = await serveCompanion({ port: 0 });
const browser = await chromium.launch({ headless: true, args: ['--renderer-process-limit=2', '--num-raster-threads=2'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
async function until(label, fn) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await delay(300); }
  throw new Error(`Timed out: ${label}`);
}
try {
  // Verify dictation mechanics without accessing Steve's microphone or a speech service.
  await page.addInitScript(() => {
    window.__dictationStarts = 0;
    window.__spoken = [];
    window.speechSynthesis.speak = utterance => { window.__spoken.push(utterance.text); };
    window.speechSynthesis.cancel = () => {};
    window.SpeechRecognition = class {
      start() { window.__dictationStarts++; setTimeout(() => { this.onresult({ results: [[{ transcript: 'Browser dictation test' }]] }); this.onend(); }, 30); }
      stop() { this.onend?.(); }
      abort() { this.onend?.(); }
    };
  });
  await page.goto(web.url);
  await page.screenshot({ path: 'artifacts/screenshots/companion-desktop.png', fullPage: true });
  assert.equal(await page.evaluate(() => window.__dictationStarts), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'artifacts/screenshots/companion-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const agent = await rooms.connect({ name: 'Test agent', ttl_minutes: 5 });
  await page.locator('#invitation').fill(agent.browser_url);
  await page.getByRole('button', { name: 'Join room' }).click();
  const frame = page.frameLocator('#dashboard');
  await frame.locator('#conn-status').filter({ hasText: 'Connected as' }).waitFor({ timeout: 35000 });
  const human = await until('browser peer discovery', () => rooms.status(agent.session_id).peers.find(peer => peer.name === 'You' && peer.connected));
  await frame.locator('#chat-target').selectOption(agent.peer_id);
  await frame.locator('#chat-input').fill('Browser to agent');
  await frame.getByRole('button', { name: 'Send', exact: true }).click();
  await until('browser message', async () => (await rooms.receive(agent.session_id, { peek: true })).messages.some(m => m.payload?.text === 'Browser to agent'));
  rooms.queue(agent.session_id, { kind: 'dm', target: human.streamId, text: 'Agent to browser' });
  await frame.locator('.type-chat .body').filter({ hasText: 'Agent to browser' }).waitFor({ timeout: 35000 });
  assert.deepEqual(await page.evaluate(() => window.__spoken), []);
  await page.locator('#read-aloud').check();
  rooms.queue(agent.session_id, { kind: 'dm', target: human.streamId, text: 'Read this reply aloud' });
  await until('opted-in read-aloud', () => page.evaluate(() => window.__spoken.some(text => text.includes('Read this reply aloud'))));
  await page.locator('#read-aloud').uncheck();
  console.log('PASS: live browser-to-agent and agent-to-browser messaging');
  await page.getByRole('button', { name: 'Dictate a message' }).click();
  await until('dictated draft', async () => await frame.locator('#chat-input').inputValue() === 'Browser dictation test');
  assert.equal((await rooms.receive(agent.session_id, { peek: true })).messages.some(m => m.payload?.text === 'Browser dictation test'), false);
  assert.equal(await page.evaluate(() => window.__dictationStarts), 1);
  await frame.getByRole('button', { name: 'Send', exact: true }).click();
  await until('explicitly sent dictation', async () => (await rooms.receive(agent.session_id, { peek: true })).messages.some(m => m.payload?.text === 'Browser dictation test'));
  console.log('PASS: mocked dictation stays a draft until the user sends it');
  const file = path.resolve('assets/icon.svg');
  await rooms.sendFile(agent.session_id, human.streamId, file);
  const downloadLink = frame.locator('a[download="icon.svg"]');
  await downloadLink.waitFor({ timeout: 35000 });
  const downloadPromise = page.waitForEvent('download');
  await downloadLink.click();
  const download = await downloadPromise;
  assert.deepEqual(await readFile(await download.path()), await readFile(file));
  console.log('PASS: real file transferred to the browser and downloaded byte-for-byte');
  await page.screenshot({ path: 'artifacts/screenshots/companion-room.png', fullPage: true,
    mask: [frame.locator('#inp-room'), frame.locator('#inp-password'), frame.locator('.type-system')] });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'artifacts/screenshots/companion-room-mobile.png', fullPage: true,
    mask: [frame.locator('#inp-room'), frame.locator('#inp-password'), frame.locator('.type-system')] });
  await page.getByRole('button', { name: 'Leave room' }).click();
  await page.locator('#welcome').waitFor();
  assert.equal(await page.locator('#read-aloud').isChecked(), false);
  assert.deepEqual(errors, []);
  console.log('PASS: desktop/mobile layout, no page errors, explicit leave');
} finally {
  await browser.close();
  await rooms.close();
  await web.close();
}
