import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { VERSION, PART_BYTES, MAX_DEMO_BYTES, validateDemoUrl, evidenceForClip, validateVideoProbe, artifactId } from './protocol.mjs';
import { captureCacheKey, loadCache, saveCache, pruneCache } from './cache.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MAX_VIDEO_BYTES = 24 * 1024 ** 2;
export const MAX_EVIDENCE_BYTES = 4 * 1024 ** 2;
export const MAX_CAMERA_EXPORT_BYTES = 4 * 1024 ** 2;
const PRIVATE_IP = /^(?:0\.|10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|224\.|240\.|255\.|::|f[cd]|fe[89ab])/i;

export function runProgram(executable, args, { signal, timeout = 60_000, maxOutput = 1024 ** 2, cwd, cancellationFile, cleanupTimeout = 90_000 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let env;
    if (process.platform === 'win32' && path.basename(executable).toLowerCase() === 'powershell.exe') {
      // A Node process started from PowerShell 7 inherits its module paths.
      // Let Windows PowerShell rebuild its own paths, so built-in commands such
      // as Get-FileHash load from the correct runtime. The parent is untouched.
      env = { ...process.env };
      for (const name of Object.keys(env)) if (name.toLowerCase() === 'psmodulepath') delete env[name];
    }
    // Capture PowerShell owns the game process and its settings transaction.
    // Terminating PowerShell on abort would skip finally and leave both behind.
    const child = spawn(executable, args, { shell: false, windowsHide: true, cwd, ...(!cancellationFile ? { signal } : {}), ...(env ? { env } : {}) });
    const output = [], errors = [];
    let bytes = 0, settled = false, stopReason, cleanupTimer;
    const requestStop = reason => {
      if (settled || stopReason) return;
      stopReason = reason;
      if (!cancellationFile) { child.kill(); finish(reason); return; }
      try { fs.writeFileSync(cancellationFile, 'cancel\n', { flag: 'wx' }); }
      catch (error) { if (error.code !== 'EEXIST') stopReason = new Error('Could not request safe capture cancellation; settings backup requires review'); }
      cleanupTimer = setTimeout(() => finish(new Error('Capture cleanup has not finished; leave the helper running and review the retained settings backup before retrying')), cleanupTimeout);
    };
    const abort = () => requestStop(new Error('Local render cancelled'));
    const timer = setTimeout(() => requestStop(new Error('Local tool exceeded its time limit')), timeout);
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(cleanupTimer); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(Buffer.concat(output).toString('utf8'));
    };
    if (cancellationFile) { signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort(); }
    for (const [stream, target] of [[child.stdout, output], [child.stderr, errors]]) {
      stream.on('data', chunk => { bytes += chunk.length; if (bytes > maxOutput) requestStop(new Error('Local tool output exceeded its limit')); else target.push(chunk); });
    }
    child.on('error', finish);
    child.on('exit', code => finish(stopReason ?? (code === 0 ? null : new Error(`Local tool failed (${code}): ${Buffer.concat(errors).toString('utf8').slice(-400)}`))));
  });
}

export async function assertNoPendingSettingsRecovery(jobsDirectory) {
  const jobs = await fsp.readdir(jobsDirectory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const entry of jobs.filter(row => row.isDirectory())) {
    const statePath = path.join(jobsDirectory, entry.name, 'capture/settings-state.json');
    let state;
    try { state = JSON.parse(await fsp.readFile(statePath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw new Error('Unreadable CS2 settings backup requires review before another capture'); }
    if (!['restored', 'not_started'].includes(state?.status)) throw new Error('A previous CS2 settings backup is pending; review it before another capture. It will never overwrite newer user settings automatically.');
  }
}

export function privateReplayAddress(address) {
  const plain = address.toLowerCase().replace(/^::ffff:/, '');
  return PRIVATE_IP.test(plain);
}

export async function downloadDemo(source, destination, { signal, maxBytes = MAX_DEMO_BYTES, lookup = dns.lookup, fetcher = fetch } = {}) {
  let url = validateDemoUrl(source);
  for (let redirect = 0; redirect <= 4; redirect++) {
    const records = await lookup(url.hostname, { all: true });
    if (!records.length || records.some(row => privateReplayAddress(row.address))) throw new Error('Replay host did not resolve to a public address');
    const response = await fetcher(url, { redirect: 'manual', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      url = validateDemoUrl(new URL(response.headers.get('location'), url).href);
      continue;
    }
    if (!response.ok || !response.body) throw new Error(`Valve Demo download failed (${response.status})`);
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes) { await response.body.cancel(); throw new Error('Demo download exceeds local size limit'); }
    const stream = fs.createWriteStream(destination, { flags: 'wx' });
    let size = 0;
    try {
      for await (const chunk of response.body) {
        signal?.throwIfAborted();
        size += chunk.length;
        if (size > maxBytes) throw new Error('Demo download exceeds local size limit');
        if (!stream.write(chunk)) await new Promise((resolve, reject) => { stream.once('drain', resolve); stream.once('error', reject); });
      }
      await new Promise((resolve, reject) => { stream.end(resolve); stream.once('error', reject); });
      if (!size) throw new Error('Downloaded Demo was empty');
      return size;
    } catch (error) { stream.destroy(); await fsp.rm(destination, { force: true }); throw error; }
  }
  throw new Error('Too many Demo download redirects');
}

export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function walk(directory) {
  const out = [];
  for (const item of await fsp.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isSymbolicLink()) throw new Error('Capture output contains an unexpected symbolic link');
    if (item.isDirectory()) out.push(...await walk(file)); else out.push(file);
    if (out.length > 20000) throw new Error('Capture output contains too many files');
  }
  return out;
}

export function selectStream(files, captureDirectory, takeFolder, name) {
  const root = path.resolve(captureDirectory), take = path.resolve(takeFolder ?? '');
  if (take !== root && !take.startsWith(root + path.sep)) throw new Error('Native stream escaped its capture directory');
  const candidates = files.filter(file => file.startsWith(take + path.sep) && file.split(path.sep).includes(name) && /\.(mp4|mov|mkv|avi)$/i.test(file));
  if (candidates.length !== 1) throw new Error(`Expected one native ${name} video; found ${candidates.length}`);
  return candidates[0];
}

export function validateCameraExport(text, frames) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_CAMERA_EXPORT_BYTES) throw new Error('Native camera export exceeds its size limit');
  if (!Array.isArray(frames) || frames.length < 1 || frames.length > 50000) throw new Error('Native camera export requires bounded frame evidence');
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const header = ['advancedfx Cam', 'version 2', 'channels time xPosition yPosition zPosition xRotation yRotation zRotation fov', 'DATA'];
  if (header.some((line, index) => lines[index] !== line)) throw new Error('Invalid native camera export header');
  const rows = lines.slice(header.length);
  if (rows.length !== frames.length) throw new Error('Native camera export and evidence frame counts differ');
  const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  const tolerance = 2e-6;
  for (let index = 0; index < rows.length; index++) {
    const tokens = rows[index].trim().split(/[ \t]+/);
    if (tokens.length !== 8 || tokens.some(value => !numeric.test(value))) throw new Error('Invalid native camera export row');
    const values = tokens.map(Number), frame = frames[index];
    if (!values.every(Number.isFinite) || values[7] < 20 || values[7] > 179) throw new Error('Invalid native camera export values');
    if (!Number.isFinite(frame?.render_time) || !Number.isFinite(frame.time) || !Number.isFinite(frame.frame_step) || frame.frame_step <= 0 ||
      (index === 0 ? frame.time !== 0 : frame.time <= frames[index - 1].time || Math.abs(frame.time - frames[index - 1].time - frame.frame_step) > 1e-8)) throw new Error('Invalid native camera evidence stream clock');
    if (Math.abs(values[0] - frame.render_time) > tolerance) throw new Error('Native camera export render time differs from evidence');
    const position = frame.camera?.position, angles = frame.camera?.angles;
    if (!Array.isArray(position) || position.length !== 3 || !position.every(Number.isFinite) || !Array.isArray(angles) || angles.length !== 3 || !angles.every(Number.isFinite)) throw new Error('Invalid native camera evidence geometry');
    // HLAE exports xRotation=roll, yRotation=pitch, zRotation=yaw. The
    // aspect-adjusted export FOV is validated above, not compared to raw FOV.
    const expected = [...position, angles[2], angles[0], angles[1]];
    if (expected.some((value, offset) => Math.abs(values[offset + 1] - value) > tolerance)) throw new Error('Native camera export position or angles differ from evidence');
  }
  return rows.length;
}

export async function optionalMatte({ source, destination, encode, record, signal, onWarning = () => {} }) {
  try {
    const metadata = await encode(source, destination, true);
    await record(destination, 'matte', { ffprobe: metadata, layout: 'color-mask-side-by-side', display_width: metadata.width / 2 });
    return true;
  } catch (error) {
    signal?.throwIfAborted();
    await fsp.rm(destination, { force: true });
    onWarning('原生人物透明层未通过编码校验，保留原生视角画面。');
    return false;
  }
}

export async function renderJob(job, installRoot, dataRoot, onStatus, { signal, runner = runProgram } = {}) {
  const runtime = JSON.parse((await fsp.readFile(path.join(installRoot, 'runtime.json'), 'utf8')).replace(/^\uFEFF/, ''));
  const powershell = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe') : 'powershell.exe';
  const script = path.join(here, 'discover-steam.ps1');
  let steam = JSON.parse((await runner(powershell, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { signal })).replace(/^\uFEFF/, ''));
  const work = path.join(dataRoot, 'jobs', job.job_id);
  await fsp.mkdir(work, { recursive: true });
  const cacheBase = path.join(dataRoot, 'cache'), cacheKey = captureCacheKey(job, steam.game_build, runtime.hlae_version);
  await pruneCache(cacheBase);
  const cached = await loadCache(cacheBase, cacheKey, job);
  if (cached) {
    onStatus('encoding', '已找到校验通过的本机缓存，正在准备上传。');
    await fsp.writeFile(path.join(work, 'receipt.json'), JSON.stringify(cached.receipt));
    return { ...cached, work };
  }
  await assertNoPendingSettingsRecovery(path.join(dataRoot, 'jobs'));
  const deadline = Date.now() + 15 * 60_000;
  do {
    signal?.throwIfAborted();
    steam = JSON.parse((await runner(powershell, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { signal })).replace(/^\uFEFF/, ''));
    if (!steam.cs2_running) break;
    onStatus('waiting_game_exit', '请先退出 CS2；不会关闭你正在进行的游戏。');
    if (Date.now() >= deadline) throw new Error('CS2 is still running; close the game and retry from the dashboard');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 3000);
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Local render cancelled')); }, { once: true });
    });
  } while (true);

  const demo = path.join(work, 'source.dem');
  onStatus('downloading', '正在准备原始 Demo。');
  if (!fs.existsSync(demo) || await hashFile(demo) !== job.plan.source_sha256) {
    await fsp.rm(demo, { force: true });
    const replayDirectory = path.resolve(path.dirname(steam.cs2), '../../csgo/replays');
    const localFiles = await fsp.readdir(replayDirectory, { withFileTypes: true }).catch(() => []);
    let cached = null;
    for (const item of localFiles.filter(item => item.isFile() && item.name.endsWith('.dem')).slice(0, 100)) {
      const candidate = path.join(replayDirectory, item.name), stat = await fsp.stat(candidate);
      if (stat.size <= MAX_DEMO_BYTES && (job.demo.bytes == null || stat.size === job.demo.bytes) && await hashFile(candidate) === job.plan.source_sha256) { cached = candidate; break; }
    }
    if (cached) await fsp.copyFile(cached, demo);
    if (!cached && !job.demo.url) {
      onStatus('waiting_demo_file', '云端已无原始下载地址，请在文件选择窗口选择这场比赛的 .dem。');
      const chosen = JSON.parse((await runner(powershell, ['-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'choose-demo.ps1')], { signal, timeout: 15 * 60_000 })).replace(/^\uFEFF/, ''));
      const stat = await fsp.stat(chosen.file);
      if (!stat.isFile() || stat.size > MAX_DEMO_BYTES || await hashFile(chosen.file) !== job.plan.source_sha256) throw new Error('Selected Demo does not match the analyzed match');
      await fsp.copyFile(chosen.file, demo);
    }
    if (!fs.existsSync(demo)) {
    const download = path.join(work, job.demo.compression === 'bz2' ? 'source.dem.bz2' : 'source.dem');
    await fsp.rm(download, { force: true });
    const downloadSignal = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(10 * 60_000)]);
    await downloadDemo(job.demo.url, download, { signal: downloadSignal });
    if (job.demo.compression === 'bz2') {
      await runner(runtime.sevenzip, ['x', '-y', `-o${work}`, download], { signal, timeout: 5 * 60_000 });
      const stat = await fsp.stat(demo);
      if (stat.size > MAX_DEMO_BYTES) throw new Error('Decompressed Demo exceeds local size limit');
      await fsp.rm(download, { force: true });
    }
    if (await hashFile(demo) !== job.plan.source_sha256) throw new Error('Demo SHA-256 does not match the analyzed match');
    }
  }
  const header = Buffer.alloc(8), handle = await fsp.open(demo, 'r');
  try { await handle.read(header, 0, 8, 0); } finally { await handle.close(); }
  if (header.toString('ascii') !== 'PBDEMS2\0') throw new Error('Downloaded source is not a CS2 Demo');
  if (job.demo.bytes != null && (await fsp.stat(demo)).size !== job.demo.bytes) throw new Error('Demo length differs from the verified source');
  const planFile = path.join(work, 'plan.json');
  await fsp.writeFile(planFile, JSON.stringify(job.plan));
  const output = path.join(work, 'capture');
  if (fs.existsSync(output)) throw new Error('This local job was already attempted; start a new job to retry');
  onStatus('rendering', '正在使用 CS2 引擎离线渲染；结束后会恢复原始游戏设置。');
  const cancellationFile = path.join(work, 'capture-cancel.request');
  let captureError;
  try { await runner(powershell, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(installRoot, 'native-animation/run-capture.ps1'), '-Plan', planFile, '-Demo', demo, '-OutputDirectory', output, '-HlaeDirectory', runtime.hlae, '-Cs2Executable', steam.cs2, '-TimeoutMinutes', '30', '-CancellationFile', cancellationFile, '-ParentNodeProcessId', String(process.pid)], { signal, timeout: 31 * 60_000, maxOutput: 4 * 1024 ** 2, cancellationFile }); }
  catch (error) { captureError = error; }
  let settingsState;
  try { settingsState = JSON.parse(await fsp.readFile(path.join(output, 'settings-state.json'), 'utf8')); }
  catch (error) { if (!captureError) throw new Error('CS2 settings restoration could not be verified; retain the private capture directory for review'); }
  if (settingsState && settingsState.status !== 'restored' && !(captureError && settingsState.status === 'not_started')) throw new Error('CS2 settings could not be safely restored. A private backup was retained; review it before rendering again.');
  if (captureError) throw captureError;
  onStatus('encoding', '正在校验并压缩原生画面。');
  const evidenceText = (await fsp.readFile(path.join(output, 'frame-evidence.jsonl'), 'utf8')).replace(/^\uFEFF/, '');
  if (evidenceText.length > 64 * 1024 ** 2) throw new Error('Engine evidence exceeded its size limit');
  const evidence = evidenceText.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const files = await walk(output), artifacts = new Map(), clips = [];
  let totalBytes = 0;
  for (const clip of job.plan.clips) {
    signal?.throwIfAborted();
    const rows = evidenceForClip(evidence, job, clip), frames = rows.filter(row => row.type === 'frame');
    const end = rows.find(row => row.type === 'clip_end');
    const entries = [];
    const recordArtifact = async (file, kind, metadata = {}) => {
      const bytes = (await fsp.stat(file)).size;
      if (bytes < 1 || bytes > (kind === 'evidence' ? MAX_EVIDENCE_BYTES : MAX_VIDEO_BYTES)) throw new Error('Native artifact exceeds its upload limit');
      const nextTotalBytes = totalBytes + bytes;
      if (nextTotalBytes > 256 * 1024 ** 2) throw new Error('Native capture exceeds the per-job upload limit');
      const artifact_id = artifactId(clip.clip_id, kind);
      const entry = { artifact_id, kind, content_type: kind === 'evidence' ? 'application/x-ndjson' : 'video/mp4', bytes, sha256: await hashFile(file), part_count: Math.ceil(bytes / PART_BYTES), part_bytes: PART_BYTES, ...metadata };
      entries.push(entry); artifacts.set(artifact_id, { ...entry, file }); totalBytes = nextTotalBytes;
    };
    const encode = async (source, destination, matte = false) => {
      const filter = matte ? '[0:v]split=2[c][a];[a]alphaextract,format=gray[mask];[c]format=yuv420p[color];[color][mask]hstack=inputs=2,format=yuv420p[out]' : null;
      const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, ...(filter ? ['-filter_complex', filter, '-map', '[out]'] : ['-map', '0:v:0']), '-an', '-c:v', 'h264_nvenc', '-preset', 'p4', '-b:v', '3M', '-maxrate', '4M', '-bufsize', '8M', '-pix_fmt', 'yuv420p', '-g', String(Math.round(job.plan.fps / 2)), '-movflags', '+faststart', destination];
      try { await runner(runtime.ffmpeg, args, { signal, timeout: 10 * 60_000 }); }
      catch (error) {
        signal?.throwIfAborted();
        const fallback = [...args];
        fallback[fallback.indexOf('h264_nvenc')] = 'libx264';
        fallback[fallback.indexOf('p4')] = 'fast';
        await runner(runtime.ffmpeg, fallback, { signal, timeout: 15 * 60_000 });
      }
      const probe = JSON.parse(await runner(runtime.ffprobe, ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', destination], { signal, timeout: 2 * 60_000 }));
      return validateVideoProbe(probe, job.plan, frames.length);
    };
    const povSource = selectStream(files, output, end.take_folder, 'nativePov');
    const cameraFile = path.join(path.resolve(end.take_folder), 'cam_main.cam');
    if (!files.includes(cameraFile)) throw new Error('Missing native camera export cam_main.cam in the capture take');
    const cameraStat = await fsp.stat(cameraFile);
    if (!cameraStat.isFile() || cameraStat.size < 1 || cameraStat.size > MAX_CAMERA_EXPORT_BYTES) throw new Error('Native camera export exceeds its size limit');
    validateCameraExport(await fsp.readFile(cameraFile, 'utf8'), frames);
    const pov = path.join(work, `${clip.clip_id}_pov.mp4`);
    const probe = await encode(povSource, pov);
    await recordArtifact(pov, 'pov', { ffprobe: probe });
    // The native POV is sufficient for exact animation. A matte is optional and
    // accepted only when the encoder can preserve its actual alpha channel.
    const matteSource = files.filter(file => file.startsWith(path.resolve(end.take_folder) + path.sep) && file.split(path.sep).includes('nativePlayers') && /\.(mov|mkv)$/i.test(file));
    if (matteSource.length === 1) {
      const matte = path.join(work, `${clip.clip_id}_matte.mp4`);
      await optionalMatte({ source: matteSource[0], destination: matte, encode, record: recordArtifact, signal, onWarning: message => onStatus('encoding', message) });
    }
    const evidenceFile = path.join(work, `${clip.clip_id}_evidence.jsonl`);
    await fsp.writeFile(evidenceFile, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    await recordArtifact(evidenceFile, 'evidence');
    clips.push({ clip_id: clip.clip_id, burst_id: clip.burst_id, fps: job.plan.fps, width: probe.width, height: probe.height, start_tick: clip.start_tick, finish_tick: clip.finish_tick, first_frame_tick: frames[0].tick, first_frame_time: frames[0].time, frame_count: frames.length, artifacts: entries });
  }
  const receipt = { version: VERSION, job_id: job.job_id, match_id: job.plan.match_id, source_sha256: job.plan.source_sha256, engine: { renderer: 'CS2/HLAE', capture_adapter: VERSION, game_build: steam.game_build, hlae_version: runtime.hlae_version }, clips };
  await fsp.writeFile(path.join(work, 'receipt.json'), JSON.stringify(receipt));
  await saveCache(cacheBase, cacheKey, { receipt, artifacts });
  // Large intermediate movies never leave this PC. Keep only upload media and
  // evidence; they are retained until the authenticated browser confirms upload.
  await fsp.rm(output, { recursive: true, force: true });
  await fsp.rm(demo, { force: true });
  return { receipt, artifacts, work };
}
