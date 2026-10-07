export async function transcribe(bytes, name, mime, signal) {
  if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY on the background service for recorded voice.');
  if (!/\.(webm|wav|mp3|m4a|mp4|mpeg|mpga)$/i.test(name)) throw new Error('Use a supported audio recording.');
  const body = new FormData();
  body.append('model', process.env.VDONINJA_TRANSCRIPTION_MODEL || 'gpt-transcribe');
  body.append('file', new Blob([bytes], { type: mime || 'application/octet-stream' }), name);
  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body,
    signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]) });
  if (!response.ok) throw new Error(`Audio transcription failed (${response.status}). Check the service API key and quota.`);
  const result = await response.json();
  if (typeof result.text !== 'string' || result.text.length > 16000) throw new Error('Invalid or oversized transcription');
  return result.text;
}
