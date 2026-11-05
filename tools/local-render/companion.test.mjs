import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import http from 'node:http';
import { createCompanion } from './companion.mjs';
import { PART_BYTES, PORT } from './protocol.mjs';

const nonce = 'd'.repeat(64), origin = 'https://your-site.example';
const job = () => ({ job_id: '8ab2cef6-60f9-4127-8bfb-670c933d79f4', plan: { kind: 'cs2_engine_capture_plan', match_id: 'a'.repeat(24), owner_steamid: '76561198000000000', source_sha256: 'b'.repeat(64), fps: 120, tickrate: 64, clips: [{ clip_id: '000', burst_id: 'r1b1', start_tick: 1000, finish_tick: 1128, preroll_tick: 808, shot_ticks: [1001] }] }, demo: { sha256: 'b'.repeat(64), bytes: 100, compression: 'none', url: 'http://replay1.valve.net/730/a.dem' } });

test('local companion requires loopback Host, session nonce and same-origin local page', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cs2-companion-'));
  let calls = 0;
  const renderer = async (value, _install, _data, status) => {
    calls++; status('rendering', 'actual engine would run here');
    const work = path.join(root, value.job_id); await fs.mkdir(work);
    const file = path.join(work, 'video.mp4'); await fs.writeFile(file, Buffer.alloc(PART_BYTES + 4, 7));
    return { work, receipt: { job_id: value.job_id, clips: [] }, artifacts: new Map([['000_pov', { file, bytes: PART_BYTES + 4, part_count: 2 }]]) };
  };
  const { server } = createCompanion({ root, launch: { origin, nonce }, renderer });
  server.listen(PORT, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${PORT}`, auth = { authorization: `Bearer ${nonce}` };
  try {
    assert.equal((await fetch(`${base}/status`)).status, 401);
    const evilHost = await new Promise((resolve, reject) => {
      const request = http.get(`${base}/status`, { headers: { ...auth, host: `evil.test:${PORT}` } }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject);
    });
    assert.equal(evilHost, 403);
    assert.equal((await fetch(`${base}/status`, { headers: { ...auth, origin: 'https://evil.test' } })).status, 403);
    assert.equal((await fetch(`${base}/job`, { method: 'GET', headers: auth })).status, 404);
    const html = await fetch(`${base}/bridge`);
    assert.match(await html.text(), /本机原生渲染/);
    assert.match(html.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const result = await fetch(`${base}/job`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(job()) });
    assert.equal(result.status, 202);
    for (let tries = 0; tries < 20; tries++) { const value = await (await fetch(`${base}/status`, { headers: auth })).json(); if (value.state === 'prepared') break; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(calls, 1);
    assert.equal((await fetch(`${base}/job`, { method: 'POST', headers: auth, body: JSON.stringify(job()) })).status, 409);
    const part = await fetch(`${base}/artifact?id=000_pov&part=1`, { headers: auth });
    assert.equal((await part.arrayBuffer()).byteLength, 4);
    assert.equal((await fetch(`${base}/artifact?id=../../secret&part=0`, { headers: auth })).status, 404);
    assert.equal((await fetch(`${base}/done`, { method: 'POST', headers: auth, body: JSON.stringify({ job_id: job().job_id, uploaded: false }) })).status, 400);
    assert.equal((await fetch(`${base}/done`, { method: 'POST', headers: auth, body: JSON.stringify({ job_id: job().job_id, uploaded: true }) })).status, 200);
    await assert.rejects(fs.stat(path.join(root, job().job_id)), { code: 'ENOENT' });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); }
});
