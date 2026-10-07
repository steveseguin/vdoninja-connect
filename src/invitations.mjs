import { randomBytes } from 'node:crypto';

export const DASHBOARD = 'https://steveseguin.github.io/ninja-p2p/dashboard.html';
const roomPattern = /^[a-zA-Z0-9_-]{8,128}$/;

export function roomCredentials(invitation) {
  if (!invitation) {
    return { room: `vdo_${randomBytes(16).toString('hex')}`, password: randomBytes(24).toString('hex') };
  }
  let url;
  try { url = new URL(invitation); } catch { throw new Error('Use the complete browser invitation URL returned by vdo_connect.'); }
  if (url.origin !== new URL(DASHBOARD).origin || url.pathname !== new URL(DASHBOARD).pathname || url.username || url.password) {
    throw new Error('Invitation must be a ninja-p2p dashboard URL. No URL is fetched.');
  }
  const room = url.searchParams.get('room');
  const password = url.searchParams.get('password');
  if (!roomPattern.test(room || '') || !password || password.length > 256 || password.startsWith('--') || /[\x00-\x1f]/.test(password)) {
    throw new Error('Invitation has an invalid room or password.');
  }
  return { room, password };
}

export function browserInvitation({ room, password }) {
  const url = new URL(DASHBOARD);
  url.search = new URLSearchParams({ room, password, name: 'You', autoconnect: 'true' }).toString();
  return url.href;
}

export function companionInvitation(invitation) {
  return `http://127.0.0.1:8791/#${new URLSearchParams({ invitation })}`;
}
