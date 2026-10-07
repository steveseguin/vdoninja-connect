import { Connection } from './connection.mjs';
const $ = id => document.getElementById(id);
let sdk, connection, credentials, stream, recorder, recording, recognition, cameraStream, recordTimer, pollTimer;
let lastRequest = null, generation = 0, polling = false;
const shown = new Set();
const storageKey = 'vdoninja-connect-pairing-v1';
function status(text) { $('status').textContent = text; }
function message(who, text, kind = '') {
  document.querySelector('.empty')?.remove();
  const box = document.createElement('div'); box.className = `message ${kind}`;
  const label = document.createElement('strong'); label.textContent = who; box.append(label, document.createTextNode(text));
  $('conversation').append(box); box.scrollIntoView({ block: 'nearest' });
}
function fail(error) { message('Connection', error.message, 'error'); }
function save(c) { localStorage.setItem(storageKey, JSON.stringify(c)); }
function envelope(payload, to) {
  return { v: 1, id: crypto.randomUUID(), type: 'event', from: { streamId: stream, name: 'Paired client', role: 'human', instanceId: stream },
    to, topic: null, ts: Date.now(), payload: { kind: 'vdo-connect', data: payload } };
}
function controls(enabled) {
  for (const id of ['send', 'cancel', 'upload', 'refresh-files', 'record', 'camera', 'disconnect']) $(id).disabled = !enabled;
  $('connect').disabled = enabled;
}
function stopMedia() {
  clearTimeout(recordTimer);
  if (recorder?.state === 'recording') recorder.stop();
  cameraStream?.getTracks().forEach(track => track.stop()); cameraStream = null;
  $('camera-preview').hidden = true; $('snapshot').disabled = true;
  recognition?.stop(); window.speechSynthesis?.cancel();
}
async function disconnect() {
  generation++; clearInterval(pollTimer); stopMedia();
  connection?.close(); connection = null; $('send-audio').disabled = true;
  const old = sdk; sdk = null; await old?.disconnect(); controls(false); status('Disconnected');
}
async function connect() {
  await disconnect();
  const turn = generation;
  let invitation = $('invitation').value.trim();
  let incoming;
  if (invitation) {
    const url = new URL(invitation);
    incoming = JSON.parse(new URLSearchParams(url.hash.slice(1)).get('invitation'));
  }
  const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
  credentials = incoming && incoming.peer !== saved?.peer ? incoming : saved || incoming;
  if (!credentials?.key || !credentials.room || !credentials.password || !credentials.service || !credentials.peer) throw new Error('Paste a valid private invitation.');
  save(credentials);
  // Remove the invitation from browser history after saving locally.
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  $('invitation').value = ''; status('Connecting…');
  stream = `owner_${crypto.randomUUID().replaceAll('-', '')}`;
  const ready = new Map(), known = new Map(), viewed = new Set();
  sdk = new VDONinjaSDK({ host: 'wss://wss.vdo.ninja', debug: false });
  const current = sdk;
  connection = new Connection(credentials, packet => {
    const uuid = ready.get(credentials.service);
    return uuid ? current.sendData(envelope(packet, credentials.service), { uuid }) : false;
  }, save);
  const conn = connection;
  conn.onResult = result => {
    if (result.id === lastRequest && ['done', 'error', 'cancelled', 'interrupted', 'unknown'].includes(result.status)) showResult(result);
  };
  function view(id) {
    if (!id || id === stream || viewed.has(id)) return;
    viewed.add(id); current.view(id, { audio: false, video: false });
  }
  current.addEventListener('peerConnected', event => { if (event.detail?.streamID) known.set(event.detail.uuid, event.detail.streamID); });
  current.addEventListener('dataChannelOpen', event => {
    const d = event.detail;
    const id = d?.streamID || known.get(d?.uuid);
    if (id) ready.set(id, d.uuid);
    current.sendData({ v: 1, id: crypto.randomUUID(), type: 'announce', from: { streamId: stream, name: 'Paired client', role: 'human', instanceId: stream },
      to: null, topic: null, ts: Date.now(), payload: { skills: [], status: 'online', version: '0.2.0', topics: [] } }, { uuid: d.uuid });
  });
  current.addEventListener('dataReceived', event => {
    let env = event.detail?.data;
    try { if (typeof env === 'string') env = JSON.parse(env); } catch { return; }
    if (env?.from?.streamId === credentials.service) ready.set(credentials.service, event.detail.uuid);
    if (env?.to === stream && env.type === 'event' && env.payload?.kind === 'vdo-connect') void conn.receive(env.payload.data);
  });
  current.addEventListener('listing', event => { for (const item of event.detail?.list || []) view(item.streamID); });
  for (const name of ['videoaddedtoroom', 'streamAdded']) current.addEventListener(name, event => view(event.detail?.streamID));
  current.addEventListener('peerDisconnected', event => {
    for (const [id, uuid] of ready) if (uuid === event.detail?.uuid) { ready.delete(id); viewed.delete(id); }
  });
  current.addEventListener('disconnected', () => { ready.clear(); status('Reconnecting…'); });
  current.addEventListener('reconnected', () => { viewed.clear(); status('Reconnected'); });
  await current.connect(); await current.joinRoom({ room: credentials.room, password: credentials.password }); await current.announce({ streamID: stream });
  await conn.pair();
  if (generation !== turn) return;
  status('Paired · private P2P connection'); controls(true);
  const info = await conn.request('status');
  $('record').disabled = !info.voice;
  if (!info.voice) $('record').title = 'Configure OPENAI_API_KEY on the service, or use Dictate a draft.';
  lastRequest = credentials.lastRequest || null;
  if (lastRequest) pollTimer = setInterval(() => void poll(), 2000);
  await files();
}
function showResult(result) {
  if (shown.has(lastRequest)) return; shown.add(lastRequest);
  clearInterval(pollTimer); $('send').disabled = !connection; status(result.status === 'done' ? 'Ready' : result.status);
  if (result.text) {
    message('Agent', result.text, result.status === 'done' ? '' : 'error');
    if ($('speak').checked && result.status === 'done' && 'speechSynthesis' in window) {
      speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(result.text));
    }
  }
}
async function poll() {
  if (!connection || !lastRequest || polling) return;
  polling = true;
  const request = lastRequest;
  try {
    const result = await connection.request('status', { request: lastRequest });
    if (request !== lastRequest) return;
    if (['done', 'error', 'cancelled', 'interrupted', 'unknown'].includes(result.status)) showResult(result);
    else status(result.status);
  } catch (error) { status(error.message); } finally { polling = false; }
}
async function ask(audio) {
  if (!connection) throw new Error('Connect first');
  const text = $('message').value.trim(); if (!text && !audio) return;
  const attachments = Array.from(document.querySelectorAll('#files input:checked'), input => input.value);
  const id = crypto.randomUUID(); lastRequest = id; credentials.lastRequest = id; save(credentials);
  $('send').disabled = true;
  message('You', text || 'Voice recording', 'you'); $('message').value = '';
  try {
    const result = await connection.request('ask', { text, attachments, ...(audio ? { audio } : {}) }, id);
    status(result.status); clearInterval(pollTimer); pollTimer = setInterval(() => void poll(), 2000);
  } catch (error) {
    if (error.message.includes('timed out')) { clearInterval(pollTimer); pollTimer = setInterval(() => void poll(), 2000); }
    else $('send').disabled = false;
    throw error;
  }
}
async function files(selected) {
  const result = await connection.request('files'); $('files').replaceChildren();
  for (const file of result.files) {
    const row = document.createElement('label'), check = document.createElement('input'); check.type = 'checkbox'; check.value = file.id; check.checked = file.id === selected;
    const download = document.createElement('button'); download.type = 'button'; download.textContent = 'Download';
    download.onclick = async () => { try {
      const result = await connection.download(file.id), url = URL.createObjectURL(new Blob([result.bytes], { type: 'application/octet-stream' }));
      const link = document.createElement('a'); link.href = url; link.download = result.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (error) { fail(error); } };
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Delete';
    remove.onclick = () => connection.request('file_delete', { file: file.id }).then(() => files()).catch(fail);
    row.append(check, document.createTextNode(` ${file.name} · ${file.size} bytes `), download, remove); $('files').append(row);
  }
}
$('connect').onclick = () => connect().catch(error => { fail(error); void disconnect(); });
$('disconnect').onclick = () => void disconnect();
$('message-form').onsubmit = event => { event.preventDefault(); void ask().catch(fail); };
$('cancel').onclick = () => connection.request('cancel').catch(fail);
$('refresh-files').onclick = () => files().catch(fail);
$('upload').onchange = async () => { try {
  const file = $('upload').files[0]; if (!file) return;
  status('Uploading…'); const id = await connection.upload(new Uint8Array(await file.arrayBuffer()), file.name, file.type); await files(id); status('File ready');
} catch (error) { fail(error); } finally { $('upload').value = ''; } };
$('forget').onclick = () => { void disconnect(); localStorage.removeItem(storageKey); credentials = null; status('Pairing forgotten. Create a new invitation to pair again.'); };
$('dictate').onclick = () => {
  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Speech) return fail(new Error('This browser does not support dictation. Use recording when available.'));
  recognition?.stop(); recognition = new Speech(); recognition.lang = navigator.language; recognition.continuous = false;
  recognition.onresult = event => { $('message').value += ( $('message').value ? ' ' : '') + event.results[0][0].transcript; };
  recognition.onerror = event => fail(new Error(`Dictation: ${event.error}`)); recognition.start();
};
$('record').onclick = async () => { try {
  if (recorder?.state === 'recording') { recorder.stop(); return; }
  const media = await navigator.mediaDevices.getUserMedia({ audio: true });
  const type = ['audio/webm;codecs=opus', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported(t));
  if (!type) { media.getTracks().forEach(t => t.stop()); throw new Error('No supported recording format'); }
  recorder = new MediaRecorder(media, { mimeType: type }); const chunks = []; let size = 0;
  recorder.ondataavailable = event => { size += event.data.size; chunks.push(event.data); if (size > 7 * 1024 * 1024 && recorder.state === 'recording') recorder.stop(); };
  recorder.onstop = () => {
    clearTimeout(recordTimer); media.getTracks().forEach(t => t.stop()); recording = new Blob(chunks, { type });
    URL.revokeObjectURL($('audio-preview').src); $('audio-preview').src = URL.createObjectURL(recording); $('audio-preview').hidden = false;
    $('send-audio').disabled = !connection; $('record').textContent = 'Record voice';
  };
  recorder.start(1000); $('record').textContent = 'Stop recording'; recordTimer = setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, 60000);
} catch (error) { fail(error); } };
$('send-audio').onclick = async () => { try {
  const extension = recording.type.includes('mp4') ? 'mp4' : 'webm';
  const id = await connection.upload(new Uint8Array(await recording.arrayBuffer()), `voice.${extension}`, recording.type);
  await ask(id); $('send-audio').disabled = true; await files();
} catch (error) { fail(error); } };
$('camera').onclick = async () => { try {
  if (cameraStream) { stopMedia(); return; }
  cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
  $('camera-preview').srcObject = cameraStream; $('camera-preview').hidden = false; await $('camera-preview').play(); $('snapshot').disabled = false;
} catch (error) { fail(error); } };
$('snapshot').onclick = async () => { try {
  const video = $('camera-preview'), canvas = document.createElement('canvas');
  const ratio = Math.min(1, 1280 / video.videoWidth); canvas.width = video.videoWidth * ratio; canvas.height = video.videoHeight * ratio;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png')); stopMedia();
  const id = await connection.upload(new Uint8Array(await blob.arrayBuffer()), 'camera.png', 'image/png'); await files(id);
} catch (error) { fail(error); } };
window.addEventListener('beforeunload', () => { stopMedia(); connection?.close(); void sdk?.disconnect(); });
if (location.hash) $('invitation').value = location.href;
else if (localStorage.getItem(storageKey)) $('invitation').placeholder = 'Saved pairing available. Click Connect to agent.';
