import { defaultRoot, readJSON } from './background-state.mjs';
import path from 'node:path';
export async function control(command, root = defaultRoot()) {
  let config;
  try { config = readJSON(path.join(root, 'config.json')); } catch { throw new Error('Run npm run background -- start first.'); }
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${config.port}/control`, { method: 'POST',
      headers: { Authorization: `Bearer ${config.controlToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command), signal: AbortSignal.timeout(10000) });
  } catch { throw new Error('Background service is not running. Run npm run background -- start.'); }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Service request failed');
  return result;
}
