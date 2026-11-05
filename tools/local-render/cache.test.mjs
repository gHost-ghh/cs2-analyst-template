import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureCacheKey, loadCache, saveCache, pruneCache, CACHE_MAX_AGE } from './cache.mjs';
import { digest, PART_BYTES, VERSION } from './protocol.mjs';

const job = () => ({ job_id: '8ab2cef6-60f9-4127-8bfb-670c933d79f4', plan: { match_id: 'a'.repeat(24), source_sha256: 'b'.repeat(64), owner_steamid: '76561198000000000', fps: 120, tickrate: 64, clips: [{ clip_id: '000', start_tick: 1000, finish_tick: 1128 }] } });

test('capture cache binds exact clip selection, source and engine versions', () => {
  const base = captureCacheKey(job(), 'steam:1', '2.192.2');
  const changed = job(); changed.plan.clips[0].finish_tick++;
  assert.notEqual(captureCacheKey(changed, 'steam:1', '2.192.2'), base);
  assert.notEqual(captureCacheKey(job(), 'steam:2', '2.192.2'), base);
  assert.notEqual(captureCacheKey(job(), 'steam:1', '2.193.0'), base);
  const secondSite = job(); secondSite.job_id = 'f0a69c6b-aab6-42ad-b247-4a552f2b7cc7';
  assert.equal(captureCacheKey(secondSite, 'steam:1', '2.192.2'), base);
});

test('capture implementation revision prevents reusing cache from the former render clock', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cs2-native-cache-revision-'));
  const current = job(), steamBuild = 'steam:1', hlaeVersion = '2.192.8';
  const legacyKey = digest(JSON.stringify({ version: VERSION, steam_build: steamBuild, hlae_version: hlaeVersion, match_id: current.plan.match_id, source_sha256: current.plan.source_sha256, owner_steamid: current.plan.owner_steamid, fps: current.plan.fps, tickrate: current.plan.tickrate, clips: current.plan.clips }));
  const currentKey = captureCacheKey(current, steamBuild, hlaeVersion);
  const source = path.join(root, 'video.mp4');
  await fs.writeFile(source, 'native-video');
  const entry = { artifact_id: '000_pov', kind: 'pov', content_type: 'video/mp4', bytes: 12, sha256: digest(Buffer.from('native-video')), part_count: 1, part_bytes: PART_BYTES, file: source };
  try {
    assert.equal(VERSION, '1.0', 'Cache invalidation must preserve the accepted wire protocol');
    assert.notEqual(currentKey, legacyKey);
    await saveCache(root, legacyKey, { receipt: { match_id: current.plan.match_id, source_sha256: current.plan.source_sha256 }, artifacts: new Map([[entry.artifact_id, entry]]) });
    assert.ok(await loadCache(root, legacyKey, current));
    assert.equal(await loadCache(root, currentKey, current), null);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('cached media is hashed before reuse and pruned by age and total bytes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cs2-native-cache-'));
  const base = path.join(root, 'cache'), source = path.join(root, 'video.mp4');
  await fs.writeFile(source, 'native-video');
  const current = job(), key = captureCacheKey(current, 'steam:1', '2.192.2');
  const entry = { artifact_id: '000_pov', kind: 'pov', content_type: 'video/mp4', bytes: 12, sha256: digest(Buffer.from('native-video')), part_count: 1, part_bytes: PART_BYTES, file: source };
  try {
    await saveCache(base, key, { receipt: { job_id: current.job_id, match_id: current.plan.match_id, source_sha256: current.plan.source_sha256, clips: [] }, artifacts: new Map([[entry.artifact_id, entry]]) });
    const other = { ...current, job_id: 'f0a69c6b-aab6-42ad-b247-4a552f2b7cc7' };
    const result = await loadCache(base, key, other);
    assert.equal(result.receipt.job_id, other.job_id);
    assert.equal(result.artifacts.get('000_pov').bytes, 12);
    await fs.writeFile(path.join(base, key, '000_pov'), 'altered-file');
    assert.equal(await loadCache(base, key, current), null);
    await pruneCache(base, { now: Date.now() + CACHE_MAX_AGE + 1000 });
    await assert.rejects(fs.stat(path.join(base, key)), { code: 'ENOENT' });
    await saveCache(base, key, { receipt: { job_id: current.job_id, match_id: current.plan.match_id, source_sha256: current.plan.source_sha256, clips: [] }, artifacts: new Map([[entry.artifact_id, entry]]) });
    await pruneCache(base, { maxBytes: 1 });
    await assert.rejects(fs.stat(path.join(base, key)), { code: 'ENOENT' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
