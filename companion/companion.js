/* Browser-only layer around the pinned ninja-p2p dashboard. */
const input = document.getElementById('invitation');
const frame = document.getElementById('dashboard');
const dictate = document.getElementById('dictate');
const readAloud = document.getElementById('read-aloud');
const voiceStatus = document.getElementById('voice-status');
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let observer = null;
let inRoom = false;

input.value = new URLSearchParams(location.hash.slice(1)).get('invitation') || '';
// Remove the invite from the address bar after consuming it; do not store it here.
if (location.hash) history.replaceState(null, '', location.pathname);
readAloud.disabled = !('speechSynthesis' in window);

function endSpeech() {
  if (recognition) recognition.abort();
  recognition = null;
  window.speechSynthesis?.cancel();
  dictate.textContent = 'Dictate a message';
}

document.getElementById('join-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const invite = new URL(input.value);
    if (invite.origin !== 'https://steveseguin.github.io' || invite.pathname !== '/ninja-p2p/dashboard.html' || invite.username || invite.password) throw new Error('Use the browser invitation from your agent.');
    const room = invite.searchParams.get('room');
    const password = invite.searchParams.get('password');
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(room || '') || !password || password.length > 256) throw new Error('The invitation is missing valid room details.');
    const params = new URLSearchParams({ room, password, name: 'You', autoconnect: 'true' });
    frame.src = `/dashboard.html?${params}`;
    inRoom = true;
    document.getElementById('welcome').hidden = true;
    document.getElementById('room').hidden = false;
    document.getElementById('join-error').textContent = '';
  } catch (error) { document.getElementById('join-error').textContent = error.message; }
});

frame.addEventListener('load', () => {
  observer?.disconnect();
  if (!inRoom) return;
  const doc = frame.contentDocument;
  const messages = doc?.getElementById('messages');
  const chat = doc?.getElementById('chat-input');
  if (!messages || !chat) {
    voiceStatus.textContent = 'The room could not load. Leave and try again.';
    return;
  }
  dictate.disabled = !SpeechRecognition;
  if (!SpeechRecognition) voiceStatus.textContent = 'Dictation is unavailable in this browser. Typing and file transfer still work.';
  observer = new MutationObserver(changes => {
    if (!readAloud.checked || recognition) return;
    const incoming = [];
    for (const change of changes) for (const node of change.addedNodes) {
      if (node.nodeType !== 1 || !node.matches('.type-chat')) continue;
      const sender = node.querySelector('.sender')?.textContent || '';
      const ownName = doc.getElementById('inp-name').value;
      if (sender === ownName || sender.startsWith(ownName + ' -> ')) continue;
      const body = node.querySelector('.body')?.textContent || '';
      incoming.push(`${sender}: ${body.slice(0, 1000)}`);
    }
    // Bound speech bursts and replace stale speech rather than building a queue.
    if (incoming.length) {
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(incoming.slice(-3).join('. ')));
    }
  });
  observer.observe(messages, { childList: true });
});

dictate.addEventListener('click', () => {
  if (recognition) { recognition.stop(); return; }
  if (!SpeechRecognition || !inRoom) return;
  const chat = frame.contentDocument?.getElementById('chat-input');
  if (!chat) return;
  window.speechSynthesis?.cancel();
  const speech = new SpeechRecognition();
  recognition = speech;
  speech.lang = document.documentElement.lang || 'en';
  speech.interimResults = false;
  speech.continuous = false;
  speech.onresult = event => {
    const transcript = event.results[0][0].transcript;
    chat.value = (chat.value + ' ' + transcript).trim();
    chat.focus();
    voiceStatus.textContent = 'Review your message, select its recipient, then choose Send.';
  };
  speech.onerror = event => { voiceStatus.textContent = `Dictation stopped (${event.error}). You can still type.`; };
  speech.onend = () => { if (recognition === speech) recognition = null; dictate.textContent = 'Dictate a message'; };
  dictate.textContent = 'Stop dictation';
  voiceStatus.textContent = 'Listening. Your browser may use its speech provider.';
  try { speech.start(); } catch { recognition = null; dictate.textContent = 'Dictate a message'; voiceStatus.textContent = 'Could not start dictation. You can still type.'; }
});
readAloud.addEventListener('change', () => { if (!readAloud.checked) window.speechSynthesis?.cancel(); });
document.getElementById('leave').addEventListener('click', () => {
  inRoom = false;
  endSpeech();
  observer?.disconnect();
  frame.contentDocument?.getElementById('btn-disconnect')?.click();
  frame.src = 'about:blank';
  readAloud.checked = false;
  dictate.disabled = true;
  document.getElementById('room').hidden = true;
  document.getElementById('welcome').hidden = false;
});
window.addEventListener('pagehide', endSpeech);
