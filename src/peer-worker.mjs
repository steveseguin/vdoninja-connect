// Own native WebRTC in a child process; never load peer-supplied code or files.
import { VDOBridge } from '@vdoninja/ninja-p2p';
let bridge;
let stopping = false;
function report(message) { if (process.connected) process.send(message, () => {}); }
async function stop() {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(0), 5500).unref();
  await bridge?.disconnect();
  process.exit(0);
}
process.on('disconnect', () => void stop());
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
process.on('message', async message => {
  if (message.type === 'stop') return void stop();
  if (message.type === 'send') {
    const ok = bridge?.bus.trySend(message.target, 'event', { kind: 'vdo-connect', data: message.packet }) || false;
    return report({ type: 'sent', id: message.id, ok });
  }
  if (message.type !== 'start' || bridge) return;
  try {
    const c = message.config;
    bridge = new VDOBridge({ room: c.room, password: c.password, streamId: c.streamId,
      identity: { streamId: c.streamId, name: c.name || 'VDO.Ninja Connect', role: 'agent' },
      busOptions: { historySize: 0, offlineQueueSize: 0 },
      agentProfile: { runtime: 'vdoninja-connect', can: ['encrypted-requests'], summary: 'Paired connections only' } });
    let count = 0;
    const rate = setInterval(() => { count = 0; }, 1000); rate.unref();
    bridge.bus.on('message:event', envelope => {
      if (envelope.to !== c.streamId || envelope.payload?.kind !== 'vdo-connect' || ++count > 100) return;
      if (JSON.stringify(envelope.payload.data).length > 50000) return;
      report({ type: 'packet', from: envelope.from.streamId, packet: envelope.payload.data });
    });
    bridge.on('error', () => report({ type: 'network', connected: false }));
    bridge.on('ws:disconnected', () => report({ type: 'network', connected: false }));
    bridge.on('ws:reconnected', () => report({ type: 'network', connected: true }));
    await bridge.connect();
    report({ type: 'ready' });
  } catch (error) { report({ type: 'failed', error: error.message }); await stop(); }
});
