import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { SignalHub } from './hub.mjs';

const reply = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
const equal = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export function createBridge({ hub = new SignalHub(), token = process.env.BRIDGE_TOKEN || '', allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://127.0.0.1:3000,http://localhost:3000').split(',') } = {}) {
  const streams = new Set();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.includes(origin)) return reply(res, 403, { error: 'ORIGIN_NOT_ALLOWED' });
    if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, Last-Event-ID' }); return res.end();
    }
    if (url.pathname === '/api/health') return reply(res, 200, { ok: true, llm_configured: Boolean(process.env.DEEPSEEK_API_KEY), model: process.env.DEEPSEEK_MODEL || 'deepseek-flash', token_required: Boolean(token), simulated_vehicle: true });
    if (token && !equal(req.headers.authorization ?? '', `Bearer ${token}`)) return reply(res, 401, { error: 'BRIDGE_TOKEN_REQUIRED' });
    if (req.method === 'GET' && url.pathname === '/api/state') return reply(res, 200, hub.snapshot());
    if (req.method === 'GET' && url.pathname === '/api/events') {
      if (streams.size >= 20) return reply(res, 429, { error: 'TOO_MANY_DISPLAYS' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const send = event => res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
      send({ id: hub.sequence, type: 'snapshot', at: Date.now(), data: hub.snapshot() });
      const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15000);
      hub.on('event', send); streams.add(res);
      req.on('close', () => { clearInterval(heartbeat); hub.off('event', send); streams.delete(res); });
      return;
    }
    if (req.method !== 'POST' || !['/api/booking', '/api/perception', '/api/run', '/api/demo', '/api/settings'].includes(url.pathname)) return reply(res, 404, { error: 'NOT_FOUND' });
    if (!req.headers['content-type']?.startsWith('application/json')) return reply(res, 415, { error: 'JSON_REQUIRED' });
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 32768) return reply(res, 413, { error: 'PAYLOAD_TOO_LARGE' }); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const name = url.pathname.split('/').at(-1);
      if (['booking', 'perception'].includes(name)) return reply(res, 202, hub.receive(name, body));
      if (name === 'settings') { hub.setMode(body.mode); return reply(res, 200, { mode: hub.mode }); }
      if (name === 'demo') {
        if (hub.active) return reply(res, 409, { error: 'RUN_IN_PROGRESS' });
        // loadDemo executes synchronously through validation before starting the async planner.
        void hub.loadDemo(body.context, body.mode ?? hub.mode).catch(() => {});
        return reply(res, 202, { accepted: true, run_id: hub.active });
      }
      if (hub.active) return reply(res, 409, { error: 'RUN_IN_PROGRESS' });
      void hub.run({ force: true }).catch(() => {});
      return reply(res, 202, { accepted: true, run_id: hub.active });
    } catch (error) {
      const known = ['EVENT_ID_CONFLICT', 'OUT_OF_ORDER_SIGNAL', 'INVALID_OBSERVED_AT', 'INVALID_EVENT_ID', 'INVALID_MODE', 'INVALID_SIGNAL', 'PAYLOAD_REQUIRED'];
      return reply(res, error.message === 'EVENT_ID_CONFLICT' ? 409 : 400, { error: known.includes(error.message) ? error.message : 'INVALID_REQUEST' });
    }
  });
  server.on('close', () => { for (const res of streams) res.end(); hub.close(); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.BRIDGE_HOST || '127.0.0.1', port = Number(process.env.BRIDGE_PORT || 8787);
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !process.env.BRIDGE_TOKEN) throw new Error('Set BRIDGE_TOKEN before opening a LAN listener.');
  createBridge().listen(port, host, () => console.log(`Signal bridge: http://${host}:${port}`));
}
