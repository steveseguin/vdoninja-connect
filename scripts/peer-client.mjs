import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Peer } from '../src/peer.mjs';
import { Connection } from '../src/connection.mjs';
import { saveJSON } from '../src/background-state.mjs';

// Keep credentials in a private file, never in process command-line arguments.
const [filename, operation = 'status', ...args] = process.argv.slice(2);
let peer, client;
try {
  if (!filename) throw new Error('Usage: npm run peer -- <private-credentials.json> [ask <text>|status [request-id]|upload <file>|download <file-id> <destination>|files|cancel]');
  const credentials = JSON.parse(readFileSync(filename, 'utf8'));
  peer = new Peer({ ...credentials, streamId: `client_${randomUUID().replaceAll('-', '')}` });
  client = new Connection(credentials, packet => peer.send(credentials.service, packet), c => saveJSON(filename, c));
  peer.on('packet', ({ packet }) => void client.receive(packet));
  await peer.start(); await client.pair();
  let result;
  if (operation === 'ask') {
    const id = randomUUID(); credentials.lastRequest = id; saveJSON(filename, credentials);
    result = await client.request('ask', { text: args.join(' ') }, id);
    const deadline = Date.now() + 210000;
    while (['running', 'queued'].includes(result.status) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      result = await client.request('status', { request: id });
    }
  } else if (operation === 'upload') {
    const bytes = readFileSync(args[0]); result = { file: await client.upload(bytes, args[0].split(/[\\/]/).pop()) };
  } else if (operation === 'download') {
    const resultFile = await client.download(args[0]); writeFileSync(args[1], resultFile.bytes, { flag: 'wx', mode: 0o600 }); result = { saved: args[1], size: resultFile.bytes.length };
  } else if (operation === 'status') result = await client.request('status', { request: args[0] || credentials.lastRequest });
  else if (['files', 'cancel'].includes(operation)) result = await client.request(operation);
  else throw new Error('Unknown peer operation');
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { client?.close(); await peer?.close(); }
