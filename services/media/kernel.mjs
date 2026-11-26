// Private transient SFU effect executor. Only the host MediaRoom adapter may call
// this capability endpoint; browser traffic terminates at the secured attachment.
import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createWorker } from 'mediasoup';
import { ControlWire } from './coordination/wire.ts';

const wire = new ControlWire({ clusterId: process.env.MEDIA_CLUSTER_ID, nodeId: process.env.MEDIA_NODE_ID, incarnation: randomUUID() });
const token = Buffer.from(process.env.MEDIA_TOKEN ?? '');
if (token.length < 64) throw new Error('MEDIA_TOKEN_REQUIRED');
const worker = await createWorker({ logLevel: 'error' });
worker.on('died', () => process.exit(1));
const webRtcServer = await worker.createWebRtcServer({ listenInfos: ['udp', 'tcp'].map(protocol => ({ protocol, ip: '0.0.0.0', announcedAddress: '127.0.0.1', port: Number(process.env.MEDIA_PORT) })) });
const router = await worker.createRouter({ mediaCodecs: [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, parameters: {} },
] });
const peers = new Map();
let owner, holder = null, grantVersion = -1;
const ownerKey = o => JSON.stringify([o.meetingId, o.generation, o.runtimeId, o.incarnation, o.attemptId]);
function closePeer(id) { const p = peers.get(id); if (p) { p.send.close(); p.recv.close(); peers.delete(id); } }
function transportOptions(t) { return { id: t.id, iceParameters: t.iceParameters, iceCandidates: t.iceCandidates, dtlsParameters: t.dtlsParameters }; }
async function execute(r) {
  if (r.action === 'closePeer') { closePeer(r.peerId); return {}; }
  if (r.action === 'sync') {
    if (!r.owner || !Number.isSafeInteger(r.owner.generation) || !Number.isSafeInteger(r.grantVersion)) throw new Error('INVALID_FENCE');
    if (owner && (owner.meetingId !== r.owner.meetingId || owner.generation > r.owner.generation || (owner.generation === r.owner.generation && ownerKey(owner) !== ownerKey(r.owner)))) throw new Error('FENCED');
    if (r.grantVersion < grantVersion) throw new Error('STALE_GRANT');
    if (owner && ownerKey(owner) !== ownerKey(r.owner)) for (const id of peers.keys()) closePeer(id);
    owner = r.owner; holder = r.holder; grantVersion = r.grantVersion;
    for (const [id, p] of peers) {
      if (!r.members.includes(p.participantId)) { closePeer(id); continue; }
      for (const producer of p.producers.values()) if (producer.appData.source === 'screen' &&
        (holder?.participantId !== p.participantId || holder.requestId !== producer.appData.requestId || producer.appData.grantVersion !== grantVersion)) producer.close();
    }
    return {};
  }
  if (!owner || ownerKey(owner) !== ownerKey(r.owner)) throw new Error('FENCED');
  if (r.action === 'open') {
    if (!peers.has(r.peerId) && peers.size >= 8) throw new Error('MEDIA_FULL');
    closePeer(r.peerId);
    const send = await router.createWebRtcTransport({ webRtcServer, enableUdp: true, enableTcp: true, preferTcp: true });
    let recv;
    try { recv = await router.createWebRtcTransport({ webRtcServer, enableUdp: true, enableTcp: true, preferTcp: true }); }
    catch (e) { send.close(); throw e; }
    peers.set(r.peerId, { participantId: r.participantId, send, recv, producers: new Map(), consumers: new Map() });
    return { rtpCapabilities: router.rtpCapabilities, send: transportOptions(send), recv: transportOptions(recv) };
  }
  const p = peers.get(r.peerId);
  if (!p || p.participantId !== r.participantId) throw new Error('MEDIA_REOPEN_REQUIRED');
  if (r.action === 'connect') {
    const t = r.direction === 'send' ? p.send : r.direction === 'recv' ? p.recv : null;
    if (!t) throw new Error('INVALID_DIRECTION');
    await t.connect({ dtlsParameters: r.dtlsParameters }); return {};
  }
  if (r.action === 'produce') {
    if (!['mic', 'camera', 'screen'].includes(r.source) || r.kind !== (r.source === 'mic' ? 'audio' : 'video')) throw new Error('INVALID_MEDIA_SOURCE');
    if (r.source === 'screen' && (holder?.participantId !== p.participantId || holder.requestId !== r.requestId || grantVersion !== r.grantVersion)) throw new Error('STALE_GRANT');
    // Close before replacing, including a revoked tab of the same participant.
    for (const other of peers.values()) for (const producer of other.producers.values()) {
      if ((r.source === 'screen' && producer.appData.source === 'screen') || (other === p && producer.appData.source === r.source)) producer.close();
    }
    const producer = await p.send.produce({ kind: r.kind, rtpParameters: r.rtpParameters, appData: { source: r.source, requestId: r.requestId, grantVersion: r.grantVersion } });
    p.producers.set(producer.id, producer); producer.observer.on('close', () => p.producers.delete(producer.id));
    return { id: producer.id };
  }
  if (r.action === 'list') return [...peers.values()].flatMap(other => [...other.producers.values()].map(producer => ({ id: producer.id, participantId: other.participantId, source: producer.appData.source })));
  if (r.action === 'closeProducer') { p.producers.get(r.producerId)?.close(); return {}; }
  if (r.action === 'consume') {
    if (p.consumers.size >= 24 || !router.canConsume({ producerId: r.producerId, rtpCapabilities: r.rtpCapabilities })) throw new Error('CANNOT_CONSUME');
    const consumer = await p.recv.consume({ producerId: r.producerId, rtpCapabilities: r.rtpCapabilities, paused: true });
    p.consumers.set(consumer.id, consumer);
    const closed = () => { consumer.close(); p.consumers.delete(consumer.id); };
    consumer.on('producerclose', closed); consumer.on('transportclose', closed);
    return { id: consumer.id, producerId: consumer.producerId, kind: consumer.kind, rtpParameters: consumer.rtpParameters };
  }
  if (r.action === 'resume') { const c = p.consumers.get(r.consumerId); if (!c) throw new Error('UNKNOWN_CONSUMER'); await c.resume(); return {}; }
  throw new Error('INVALID_MEDIA_ACTION');
}
let pending = 0, tail = Promise.resolve();
const server = createServer(async (request, response) => {
  const supplied = Buffer.from((request.headers.authorization ?? '').replace(/^Bearer /, ''));
  if (request.method !== 'POST' || request.url !== '/v1/control' || supplied.length !== token.length || !timingSafeEqual(supplied, token)) { response.writeHead(403).end(); return; }
  if (pending >= 16) { response.writeHead(503).end(); return; }
  pending++; let packet;
  const deadline = setTimeout(() => request.destroy(), 5000);
  try {
    let bytes = 0; const chunks = [];
    for await (const chunk of request) { bytes += chunk.length; if (bytes > 1024 * 1024) throw new Error('INPUT_LIMIT'); chunks.push(chunk); }
    const raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (raw.nodeId !== process.env.MEDIA_CALLER_ID) throw new Error('UNAUTHORIZED');
    packet = wire.accept(raw);
    const work = tail.then(() => execute(packet.body)); tail = work.catch(() => {});
    const value = await work;
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(wire.reply(packet, { epoch: wire.identity.incarnation, value })) + '\n');
  } catch (e) {
    if (packet) response.writeHead(200).end(JSON.stringify(wire.reply(packet, null, { code: /^[A-Z_]+$/.test(e.message) ? e.message : 'MEDIA_ERROR', message: 'Media effect failed' })) + '\n');
    else response.writeHead(400).end();
  } finally { clearTimeout(deadline); pending--; }
});
server.headersTimeout = 5000; server.requestTimeout = 5000; server.maxConnections = 32;
server.listen(8080, '0.0.0.0');
process.once('SIGTERM', () => { worker.close(); server.close(() => process.exit()); });
