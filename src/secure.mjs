// Shared by the browser and Node clients. Each invitation has its own key.
export const PROTOCOL = 'vdoninja-connect/1';
export const CHUNK = 12288;
export const MAX_FILE = 8 * 1024 * 1024;
const encoder = new TextEncoder();
export function base64(bytes) {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}
export function unbase64(text) {
  return Uint8Array.from(atob(text), char => char.charCodeAt(0));
}
export function secret() { return base64(crypto.getRandomValues(new Uint8Array(32))); }
export async function digest(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
export async function seal(key, peer, service, direction, value) {
  const plaintext = encoder.encode(JSON.stringify(value));
  if (plaintext.length > 32768) throw new Error('Message exceeds 32 KiB. Send a file or a shorter message.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const imported = await crypto.subtle.importKey('raw', unbase64(key), 'AES-GCM', false, ['encrypt']);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv,
    additionalData: encoder.encode(`${PROTOCOL}:${peer}:${service}:${direction}`) }, imported, plaintext);
  return { protocol: PROTOCOL, peer, iv: base64(iv), data: base64(new Uint8Array(data)) };
}
export async function unseal(key, packet, service, direction) {
  if (packet?.protocol !== PROTOCOL || typeof packet.data !== 'string' || packet.data.length > 48000 ||
      typeof packet.iv !== 'string' || unbase64(packet.iv).length !== 12) throw new Error('Invalid packet');
  const imported = await crypto.subtle.importKey('raw', unbase64(key), 'AES-GCM', false, ['decrypt']);
  const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(packet.iv),
    additionalData: encoder.encode(`${PROTOCOL}:${packet.peer}:${service}:${direction}`) }, imported, unbase64(packet.data));
  return JSON.parse(new TextDecoder().decode(data));
}
