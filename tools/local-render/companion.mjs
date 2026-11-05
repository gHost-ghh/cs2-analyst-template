import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { PORT, VERSION, PART_BYTES, SHA256, CLOUD_ORIGINS, parseLaunchUri, validateJob } from './protocol.mjs';
import { renderJob } from './capture-runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const site = `http://127.0.0.1:${PORT}`;
const constantEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const json = (response, status, body) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(body)); };

async function readJson(request, maximum = 256 * 1024) {
  const chunks = []; let bytes = 0;
  for await (const chunk of request) { bytes += chunk.length; if (bytes > maximum) throw new Error('Local request too large'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createCompanion({ root, launch, renderer = renderJob, now = Date.now } = {}) {
  const sessions = new Map(), seenJobs = new Set();
  let busy = null, lastActivity = now();
  const activate = value => {
    if (!CLOUD_ORIGINS.has(value?.origin) || !SHA256.test(value?.nonce)) throw new Error('Invalid one-time launch');
    if (sessions.size >= 8 && !sessions.has(value.nonce)) {
      const previous = [...sessions.values()].find(session => busy?.session !== session);
      if (previous) sessions.delete(previous.nonce); else throw new Error('Too many local browser sessions');
    }
    if (!sessions.has(value.nonce)) sessions.set(value.nonce, { origin: value.origin, nonce: value.nonce, created: now(), state: 'ready', message: '等待网页提交渲染任务。', result: null, jobId: null });
    lastActivity = now();
  };
  if (launch) activate(launch);
  const server = http.createServer(async (request, response) => {
    try {
      if (request.headers.host !== `127.0.0.1:${PORT}` || !['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) return json(response, 403, { error: 'Loopback only' });
      if (request.headers.origin && request.headers.origin !== site) return json(response, 403, { error: 'Local page origin required' });
      const url = new URL(request.url, site);
      if (request.method === 'POST' && url.pathname === '/activate') {
        if (request.headers.origin) return json(response, 403, { error: 'Native activation required' });
        activate(await readJson(request, 1024));
        return json(response, 200, { ok: true });
      }
      if (request.method === 'GET' && ['/bridge', '/bridge.js', '/bridge.css'].includes(url.pathname)) {
        const name = url.pathname === '/bridge' ? 'bridge.html' : url.pathname.slice(1);
        response.writeHead(200, { 'content-type': name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'text/css; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
        response.end(await fs.readFile(path.join(here, name)));
        return;
      }
      const bearer = request.headers.authorization?.replace(/^Bearer /, '');
      const session = [...sessions.values()].find(value => constantEqual(value.nonce, bearer));
      if (!session || now() - session.created > 6 * 60 * 60_000) return json(response, 401, { error: 'Local browser session expired' });
      if (request.method === 'GET' && url.pathname === '/status') return json(response, 200, { version: VERSION, origin: session.origin, state: session.state, message: session.message, job_id: session.jobId, receipt: session.result?.receipt ?? null });
      if (request.method === 'POST' && url.pathname === '/job') {
        if (busy) return json(response, 409, { error: 'Another local capture is already running' });
        const job = validateJob(await readJson(request));
        if (seenJobs.has(job.job_id)) return json(response, 409, { error: 'This local job was already attempted' });
        seenJobs.add(job.job_id);
        lastActivity = now();
        const controller = new AbortController();
        busy = { session, controller }; session.jobId = job.job_id; session.result = null; session.state = 'starting'; session.message = '正在检查本地 CS2。';
        json(response, 202, { ok: true, job_id: job.job_id });
        renderer(job, root, root, (state, message) => { session.state = state; session.message = message; }, { signal: controller.signal }).then(result => {
          session.result = result; session.state = 'prepared'; session.message = '渲染完成，正在等待网页上传。';
        }).catch(error => {
          session.state = 'failed'; session.message = String(error.message ?? error).slice(0, 400);
          busy = null; lastActivity = now();
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/artifact') {
        const artifact = session.result?.artifacts.get(url.searchParams.get('id'));
        const part = Number(url.searchParams.get('part'));
        if (!artifact || !Number.isSafeInteger(part) || part < 0 || part >= artifact.part_count) return json(response, 404, { error: 'Native artifact part not found' });
        const offset = part * PART_BYTES, length = Math.min(PART_BYTES, artifact.bytes - offset);
        const buffer = Buffer.alloc(length), file = await fs.open(artifact.file, 'r');
        try { const { bytesRead } = await file.read(buffer, 0, length, offset); if (bytesRead !== length) throw new Error('Native artifact changed during upload'); } finally { await file.close(); }
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(buffer); return;
      }
      if (request.method === 'POST' && url.pathname === '/done') {
        if (busy?.session !== session || !session.result) return json(response, 409, { error: 'No prepared local capture' });
        const payload = await readJson(request, 1024);
        if (payload.job_id !== session.jobId || payload.uploaded !== true) return json(response, 400, { error: 'Cloud upload confirmation required' });
        await fs.rm(session.result.work, { recursive: true, force: true });
        session.state = 'complete'; session.message = '原生回放已上传，可以返回网页查看。'; session.result = null; busy = null; lastActivity = now();
        return json(response, 200, { ok: true });
      }
      return json(response, 404, { error: 'Unknown local render operation' });
    } catch (error) { if (!response.headersSent) json(response, 400, { error: String(error.message ?? error).slice(0, 400) }); else response.destroy(); }
  });
  const sweep = setInterval(() => {
    if (!busy && now() - lastActivity > 15 * 60_000) { server.close(); clearInterval(sweep); }
  }, 30_000);
  sweep.unref();
  server.on('close', () => clearInterval(sweep));
  return { server, sessions, activate };
}

async function main() {
  if (process.platform !== 'win32' || process.argv.length !== 3) throw new Error('Use the installed Windows CS2 Demo Lab protocol');
  const launch = parseLaunchUri(process.argv[2]);
  const root = path.dirname(here);
  const { server } = createCompanion({ root, launch });
  server.on('error', async error => {
    if (error.code !== 'EADDRINUSE') { console.error('本地渲染启动失败：' + error.message); process.exitCode = 1; return; }
    try {
      const response = await fetch(`${site}/activate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(launch), signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error('The local port is in use by another application');
      console.log('已连接正在运行的本地渲染助手。');
    } catch (cause) { console.error('无法连接本地渲染助手：' + cause.message); process.exitCode = 1; }
    server.close();
  });
  server.listen(PORT, '127.0.0.1', () => console.log('CS2 Demo Lab 本地渲染助手已启动。请保持网页与此窗口打开；空闲后会自动退出。'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
