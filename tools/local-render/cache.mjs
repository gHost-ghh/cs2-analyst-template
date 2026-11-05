import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { VERSION, SHA256, PART_BYTES } from './protocol.mjs';

export const CACHE_MAX_BYTES = 2 * 1024 ** 3;
export const CACHE_MAX_AGE = 7 * 24 * 60 * 60_000;
export const CAPTURE_IMPLEMENTATION_REVISION = 'render-clock-2';
const validArtifactId = value => /^[a-z0-9_-]{1,80}$/.test(value);
const hashFile = async file => { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); };

export function captureCacheKey(job, steamBuild, hlaeVersion) {
  return createHash('sha256').update(JSON.stringify({ version: VERSION, capture_implementation: CAPTURE_IMPLEMENTATION_REVISION, steam_build: steamBuild, hlae_version: hlaeVersion, match_id: job.plan.match_id, source_sha256: job.plan.source_sha256, owner_steamid: job.plan.owner_steamid, fps: job.plan.fps, tickrate: job.plan.tickrate, clips: job.plan.clips })).digest('hex');
}

export async function pruneCache(base, { now = Date.now(), maxBytes = CACHE_MAX_BYTES, maxAge = CACHE_MAX_AGE, retain } = {}) {
  await fs.mkdir(base, { recursive: true });
  const entries = [];
  for (const item of await fs.readdir(base, { withFileTypes: true })) {
    if (!SHA256.test(item.name) || !item.isDirectory()) continue;
    const folder = path.join(base, item.name);
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(folder, 'manifest.json'), 'utf8'));
      const bytes = manifest.artifacts.reduce((sum, entry) => sum + entry.bytes, 0);
      const modified = (await fs.stat(path.join(folder, 'manifest.json'))).mtimeMs;
      if (item.name !== retain && (now - modified > maxAge || !Number.isSafeInteger(bytes) || bytes > 256 * 1024 ** 2)) await fs.rm(folder, { recursive: true, force: true });
      else entries.push({ folder, bytes, modified, key: item.name });
    } catch { if (item.name !== retain) await fs.rm(folder, { recursive: true, force: true }); }
  }
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  for (const entry of entries.sort((a, b) => a.modified - b.modified)) {
    if (total <= maxBytes) break;
    if (entry.key === retain) continue;
    await fs.rm(entry.folder, { recursive: true, force: true }); total -= entry.bytes;
  }
}

export async function loadCache(base, key, job) {
  if (!SHA256.test(key)) throw new Error('Invalid local capture cache key');
  const folder = path.join(base, key), manifestFile = path.join(folder, 'manifest.json');
  try {
    const stat = await fs.lstat(manifestFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 ** 2) return null;
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    if (manifest.key !== key || manifest.receipt?.source_sha256 !== job.plan.source_sha256 || manifest.receipt?.match_id !== job.plan.match_id || !Array.isArray(manifest.artifacts) || manifest.artifacts.length > 48) return null;
    const artifacts = new Map();
    for (const entry of manifest.artifacts) {
      if (!validArtifactId(entry.artifact_id) || !SHA256.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > 24 * 1024 ** 2 || entry.part_bytes !== PART_BYTES || entry.part_count !== Math.ceil(entry.bytes / PART_BYTES)) return null;
      const file = path.join(folder, entry.artifact_id), item = await fs.lstat(file);
      if (!item.isFile() || item.isSymbolicLink() || item.size !== entry.bytes || await hashFile(file) !== entry.sha256) return null;
      artifacts.set(entry.artifact_id, { ...entry, file });
    }
    await fs.utimes(manifestFile, new Date(), new Date());
    return { receipt: { ...manifest.receipt, job_id: job.job_id }, artifacts };
  } catch { return null; }
}

export async function saveCache(base, key, result) {
  if (!SHA256.test(key)) throw new Error('Invalid local capture cache key');
  await fs.mkdir(base, { recursive: true });
  const folder = path.join(base, key), temporary = path.join(base, `${key}.partial-${randomUUID()}`);
  await fs.mkdir(temporary);
  try {
    const entries = [];
    for (const entry of result.artifacts.values()) {
      if (!validArtifactId(entry.artifact_id)) throw new Error('Invalid cache artifact ID');
      await fs.copyFile(entry.file, path.join(temporary, entry.artifact_id));
      const { file, ...metadata } = entry; entries.push(metadata);
    }
    await fs.writeFile(path.join(temporary, 'manifest.json'), JSON.stringify({ version: VERSION, key, receipt: result.receipt, artifacts: entries }));
    await fs.rm(folder, { recursive: true, force: true });
    await fs.rename(temporary, folder);
    await pruneCache(base, { retain: key });
  } catch (error) { await fs.rm(temporary, { recursive: true, force: true }); throw error; }
}
