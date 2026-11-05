import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateJob, parseLaunchUri, validateDemoUrl, evidenceForClip, validateVideoProbe, digest } from './protocol.mjs';
import { downloadDemo, privateReplayAddress, selectStream, optionalMatte, validateCameraExport, renderJob, MAX_CAMERA_EXPORT_BYTES, runProgram, assertNoPendingSettingsRecovery } from './capture-runtime.mjs';

export function fixtureJob() {
  return { job_id: '8ab2cef6-60f9-4127-8bfb-670c933d79f4', plan: { kind: 'cs2_engine_capture_plan', match_id: 'a'.repeat(24), owner_steamid: '76561198000000000', source_sha256: 'b'.repeat(64), fps: 120, tickrate: 64, clips: [{ clip_id: '000', burst_id: 'round-1-burst-1', start_tick: 1000, finish_tick: 1128, preroll_tick: 808, shot_ticks: [1001], target_steamids: ['76561197964020430'] }] }, demo: { status: 'available', url: 'http://replay128.valve.net/730/abc.dem.bz2', sha256: 'b'.repeat(64), bytes: 1000, compression: 'bz2' } };
}

test('Windows PowerShell uses its own modules when Node inherits PowerShell 7 paths', { skip: process.platform !== 'win32' }, async () => {
  const original = process.env.PSModulePath;
  const incompatible = path.join(os.tmpdir(), 'cs2-powershell7-module-probe');
  process.env.PSModulePath = incompatible;
  try {
    const output = await runProgram(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-Command', '[bool](Get-Command Get-FileHash -ErrorAction SilentlyContinue)'], { timeout: 10000 });
    assert.equal(output.trim(), 'True');
    assert.equal(process.env.PSModulePath, incompatible);
  } finally {
    if (original === undefined) delete process.env.PSModulePath; else process.env.PSModulePath = original;
  }
});

test('custom URI binds exactly one approved origin and a 256-bit nonce', () => {
  const uri = `cs2lab://render?origin=${encodeURIComponent('https://your-site.example')}&nonce=${'a'.repeat(64)}`;
  assert.equal(parseLaunchUri(uri).origin, 'https://your-site.example');
  for (const bad of [uri.replace('your-site.example', 'evil.example'), `${uri}&command=calc`, `${uri}&nonce=${'c'.repeat(64)}`, uri.replace('cs2lab:', 'https:'), `${uri}#evil`]) assert.throws(() => parseLaunchUri(bad));
});

test('browser data cannot choose executables, shell commands or output paths', () => {
  const job = fixtureJob();
  Object.assign(job.plan, { output_directory: 'C:/Windows', command: 'calc.exe', script: 'evil()' });
  const safe = validateJob(job);
  assert.equal(safe.plan.output_directory, undefined);
  assert.equal(safe.plan.command, undefined);
  for (const mutate of [j => { j.plan.clips[0].clip_id = '../bad'; }, j => { j.plan.clips[0].finish_tick = 4000; }, j => { j.plan.owner_steamid = '0'; }, j => { j.plan.clips = []; }, j => { j.demo.sha256 = 'c'.repeat(64); }, j => { j.plan.clips[0].shot_ticks = []; }]) {
    const invalid = fixtureJob(); mutate(invalid); assert.throws(() => validateJob(invalid));
  }
});

test('expired-source plans still bind local cached Demos to the observed SHA', () => {
  const job = fixtureJob(); job.demo.url = null; job.demo.status = 'source_unavailable';
  assert.equal(validateJob(job).demo.url, null);
});

test('Demo sources use only official replay hosts and bounded filenames', () => {
  for (const host of ['replay128.valve.net', 'replay1.wmsj.cn', 'replay999.csgo.com.cn']) assert.equal(validateDemoUrl(`http://${host}/730/example_1.dem.bz2`).hostname, host);
  for (const url of ['file:///etc/passwd', 'http://localhost/730/a.dem', 'http://replay1.valve.net.evil.com/730/a.dem', 'http://replay1.valve.net/730/../a.dem', 'http://replay1.valve.net/730/a.dem?secret=x', 'https://replay1.valve.net:8443/730/a.dem', 'http://user:pass@replay1.valve.net/730/a.dem']) assert.throws(() => validateDemoUrl(url));
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.2', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fc00::1']) assert.equal(privateReplayAddress(ip), true);
  assert.equal(privateReplayAddress('8.8.8.8'), false);
});

test('download limits apply to actual bytes and every redirect is revalidated', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cs2-local-download-'));
  const lookup = async () => [{ address: '8.8.8.8' }];
  const file = path.join(root, 'test.dem');
  try {
    await downloadDemo('http://replay1.valve.net/730/a.dem', file, { lookup, fetcher: async () => new Response('abc'), maxBytes: 3 });
    assert.equal(digest(await fs.readFile(file)), digest(Buffer.from('abc')));
    await fs.rm(file);
    await assert.rejects(downloadDemo('http://replay1.valve.net/730/a.dem', file, { lookup, fetcher: async () => new Response('abcd'), maxBytes: 3 }), /exceeds/);
    await assert.rejects(downloadDemo('http://replay1.valve.net/730/a.dem', file, { lookup, fetcher: async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/a.dem' } }) }), /approved replay/);
    await assert.rejects(downloadDemo('http://replay1.valve.net/730/a.dem', file, { lookup: async () => [{ address: '127.0.0.1' }], fetcher: async () => { throw new Error('must not fetch'); } }), /public address/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('native evidence must finish with exact source, identity, frame order and tick coverage', () => {
  const job = fixtureJob(), clip = { ...job.plan.clips[0], finish_tick: 1001 };
  const rows = [
    { type: 'clip_start', clip_id: '000', source_sha256: job.plan.source_sha256, owner_steamid: job.plan.owner_steamid, camera_mode: 'verified_native_spectator', tick: 1000 },
    { type: 'frame', clip_id: '000', frame: 0, tick: 1000, time: 15.625, camera: { position: [0, 0, 64] } },
    { type: 'frame', clip_id: '000', frame: 1, tick: 1001, time: 15.633, camera: { position: [0, 0, 64] } },
    { type: 'clip_end', clip_id: '000', frames: 2, tick: 1002, camera_rejected: false },
    { type: 'complete', match_id: job.plan.match_id, source_sha256: job.plan.source_sha256, clips: 1 },
  ];
  assert.equal(evidenceForClip(rows, job, clip).length, 5);
  for (const mutate of [r => r.pop(), r => { r[0].camera_mode = 'guessed'; }, r => { r[2].frame = 3; }, r => { r[2].time = 1; }, r => { r[3].tick = 1001; }, r => { r[4].source_sha256 = 'c'.repeat(64); }]) {
    const invalid = structuredClone(rows); mutate(invalid); assert.throws(() => evidenceForClip(invalid, job, clip));
  }
});

test('native video probe rejects wrong FPS or missing frames', () => {
  const probe = { streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '120/1', nb_read_frames: '240', duration: '2' }] };
  assert.equal(validateVideoProbe(probe, { fps: 120 }, 240).nb_frames, 240);
  assert.throws(() => validateVideoProbe(probe, { fps: 60 }, 240));
  assert.throws(() => validateVideoProbe(probe, { fps: 120 }, 230));
});

test('native stream selection is confined to the actual take directory', () => {
  const root = path.resolve('/capture'), take = path.join(root, 'clip-000', 'take0000');
  assert.equal(selectStream([path.join(take, 'nativePov/video.mp4')], root, take, 'nativePov'), path.join(take, 'nativePov/video.mp4'));
  assert.throws(() => selectStream(['/other/nativePov/video.mp4'], root, '/other', 'nativePov'), /escaped/);
  assert.throws(() => selectStream([path.join(take, 'nativePov/a.mp4'), path.join(take, 'nativePov/b.mp4')], root, take, 'nativePov'), /Expected one/);
});

const cameraHeader = 'advancedfx Cam\nversion 2\nchannels time xPosition yPosition zPosition xRotation yRotation zRotation fov\nDATA';
function cameraFrames() {
  return [73.4926224, 73.4853288, 73.5001201, 73.5084534].map((render_time, frame) => ({
    type: 'frame', clip_id: '000', frame, tick: frame < 2 ? 1000 : 1001,
    time: frame / 120, frame_step: 1 / 120, render_time, demo_time: (frame < 2 ? 1000 : 1001) / 64,
    camera: { position: [12.1234564 + frame, -24.7654321, 64.0000004], angles: [3.1234564, 94.2345674 + frame, 1.3456784], fov: 90 },
  }));
}
function cameraText(frames = cameraFrames()) {
  return cameraHeader + '\n' + frames.map(frame => [frame.render_time, ...frame.camera.position, frame.camera.angles[2], frame.camera.angles[0], frame.camera.angles[1], 106.260205].map(value => value.toFixed(6)).join(' ')).join('\n') + '\n';
}

test('native camera export preserves every render including same-tick frames and TrueView clock backsteps', () => {
  const frames = cameraFrames(), text = cameraText(frames);
  assert.equal(frames[0].tick, frames[1].tick);
  assert.ok(frames[1].render_time < frames[0].render_time);
  assert.ok(frames[1].time > frames[0].time);
  assert.equal(validateCameraExport(text, frames), 4);
  assert.equal(validateCameraExport(text.replaceAll('\n', '\r\n'), frames), 4);
});

test('native camera export rejects changed headers, dropped or duplicated rows and malformed numbers', () => {
  const text = cameraText(), lines = text.trimEnd().split('\n');
  for (const invalid of [text.replace('version 2', 'version 1'), text.replace('xRotation', 'pitch'), lines.slice(0, -1).join('\n'), [...lines, lines.at(-1)].join('\n'), text.replace('106.260205', 'NaN'), text.replace('106.260205', 'Infinity'), text.replace('106.260205', '180'), text.replace('106.260205', '0x60'), text.replace('106.260205', '106.260205 1')]) {
    assert.throws(() => validateCameraExport(invalid, cameraFrames()), /native camera/i);
  }
});

test('native camera export rejects changed raw render times, position and angle order', () => {
  const frames = cameraFrames(), text = cameraText(frames);
  for (const mutate of [rows => { rows[1].render_time += 0.00001; }, rows => { rows[1].camera.position[0] += 0.00001; }, rows => { rows[1].camera.angles.reverse(); }, rows => { rows[1].camera.angles[1] = NaN; }]) {
    const invalid = structuredClone(frames); mutate(invalid);
    assert.throws(() => validateCameraExport(text, invalid), /native camera/i);
  }
  const swapped = text.trimEnd().split('\n'); [swapped[4], swapped[5]] = [swapped[5], swapped[4]];
  assert.throws(() => validateCameraExport(swapped.join('\n'), frames), /render time/);
});

test('native camera export requires the observed frame-step mapping to monotonic stream time', () => {
  const frames = cameraFrames(), text = cameraText(frames);
  for (const mutate of [rows => { rows[0].time = 0.0001; }, rows => { rows[1].time = rows[0].time; }, rows => { rows[2].time += 0.00001; }, rows => { rows[1].frame_step = 0; }, rows => { rows[1].frame_step = Infinity; }, rows => { delete rows[1].frame_step; }, rows => { rows.forEach(row => { row.time = row.render_time; }); }]) {
    const invalid = structuredClone(frames); mutate(invalid);
    assert.throws(() => validateCameraExport(text, invalid), /stream clock/);
  }
});

async function fixtureRender(camera, check) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cs2-native-camera-'));
  const install = path.join(root, 'install'), data = path.join(root, 'data'), job = fixtureJob();
  const work = path.join(data, 'jobs', job.job_id);
  const demo = Buffer.from('PBDEMS2\0bounded-offline-fixture');
  job.plan.clips[0].finish_tick = 1001;
  job.plan.source_sha256 = job.demo.sha256 = digest(demo); job.demo.bytes = demo.length;
  await fs.mkdir(install, { recursive: true }); await fs.mkdir(work, { recursive: true });
  await fs.writeFile(path.join(install, 'runtime.json'), JSON.stringify({ hlae_version: 'fixture', hlae: 'fixture-hlae', ffmpeg: 'fixture-ffmpeg', ffprobe: 'fixture-ffprobe' }));
  await fs.writeFile(path.join(work, 'source.dem'), demo);
  let encoded = 0;
  const runner = async (executable, args) => {
    const source = args[args.indexOf('-File') + 1];
    if (source?.endsWith('discover-steam.ps1')) return JSON.stringify({ cs2: path.join(root, 'game', 'bin', 'win64', 'cs2.exe'), game_build: 'fixture', cs2_running: false });
    if (source?.endsWith('run-capture.ps1')) {
      const output = args[args.indexOf('-OutputDirectory') + 1], take = path.join(output, 'clip-000', 'take0000');
      await fs.mkdir(path.join(take, 'nativePov'), { recursive: true });
      await fs.writeFile(path.join(output, 'settings-state.json'), JSON.stringify({ status: 'restored' }));
      await fs.writeFile(path.join(take, 'nativePov', 'video.mp4'), 'inert-native-input');
      const rows = [
        { type: 'clip_start', clip_id: '000', source_sha256: job.plan.source_sha256, owner_steamid: job.plan.owner_steamid, camera_mode: 'verified_native_spectator', tick: 1000 },
        ...cameraFrames(), { type: 'clip_end', clip_id: '000', frames: 4, tick: 1002, camera_rejected: false, take_folder: take },
        { type: 'complete', match_id: job.plan.match_id, source_sha256: job.plan.source_sha256, clips: 1 },
      ];
      await fs.writeFile(path.join(output, 'frame-evidence.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
      if (camera) await camera(take);
      return '';
    }
    if (executable === 'fixture-ffmpeg') { encoded++; await fs.writeFile(args.at(-1), 'inert-encoded-output'); return ''; }
    if (executable === 'fixture-ffprobe') return JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '120/1', nb_read_frames: '4', duration: String(4 / 120) }] });
    throw new Error('Unexpected offline fixture command');
  };
  try { await check(() => renderJob(job, install, data, () => {}, { runner }), () => encoded); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('render job validates the exact take camera export before encoding', async () => {
  await fixtureRender(take => fs.writeFile(path.join(take, 'cam_main.cam'), cameraText()), async (render, encoded) => {
    const result = await render();
    assert.equal(encoded(), 1);
    assert.equal(result.receipt.clips[0].frame_count, 4);
    assert.equal(result.receipt.clips[0].first_frame_time, 0);
  });
});

test('capture cancellation and timeout await cooperative child cleanup instead of terminating it', async () => {
  for (const mode of ['abort', 'timeout']) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cs2-cooperative-stop-'));
    const cancellationFile = path.join(root, 'cancel'), restored = path.join(root, 'restored'), ready = path.join(root, 'ready');
    const controller = new AbortController();
    const script = `const fs=require('node:fs');fs.writeFileSync(process.argv[3],'ready');const timer=setInterval(()=>{if(fs.existsSync(process.argv[1])){clearInterval(timer);setTimeout(()=>{fs.writeFileSync(process.argv[2],'exact bytes restored');process.exit(1)},150)}},10)`;
    try {
      const run = runProgram(process.execPath, ['-e', script, cancellationFile, restored, ready], { signal: controller.signal, cancellationFile, timeout: mode === 'timeout' ? 400 : 5000, cleanupTimeout: 5000 });
      const rejected = assert.rejects(run, mode === 'timeout' ? /time limit/ : /cancelled/);
      const deadline = Date.now() + 3000;
      while (!await fs.stat(ready).catch(() => null)) { if (Date.now() > deadline) throw new Error('Inert child did not start'); await new Promise(resolve => setTimeout(resolve, 10)); }
      if (mode === 'abort') controller.abort();
      await rejected;
      assert.equal(await fs.readFile(restored, 'utf8'), 'exact bytes restored');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }
});

test('pending or unreadable old settings backups block a fresh capture without restoring them', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cs2-pending-settings-'));
  const backup = path.join(root, 'old-job/capture');
  try {
    await fs.mkdir(backup, { recursive: true });
    const state = path.join(backup, 'settings-state.json');
    await fs.writeFile(state, JSON.stringify({ status: 'pending' }));
    await assert.rejects(assertNoPendingSettingsRecovery(root), /pending/);
    assert.equal((JSON.parse(await fs.readFile(state, 'utf8'))).status, 'pending');
    await fs.writeFile(state, 'invalid');
    await assert.rejects(assertNoPendingSettingsRecovery(root), /Unreadable/);
    await fs.writeFile(state, JSON.stringify({ status: 'restored' }));
    await assert.doesNotReject(assertNoPendingSettingsRecovery(root));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('render job refuses missing, misplaced, oversized and corrupt exports before encoding', async () => {
  const cases = [
    null,
    async take => { await fs.mkdir(path.join(take, 'other')); await fs.writeFile(path.join(take, 'other', 'cam_main.cam'), cameraText()); },
    take => fs.writeFile(path.join(take, 'cam_main.cam'), Buffer.alloc(MAX_CAMERA_EXPORT_BYTES + 1, 32)),
    take => fs.writeFile(path.join(take, 'cam_main.cam'), cameraText().replace('73.485329', '73.485339')),
  ];
  for (const camera of cases) await fixtureRender(camera, async (render, encoded) => {
    await assert.rejects(render(), /native camera/i);
    assert.equal(encoded(), 0, 'Invalid camera evidence must fail before FFmpeg');
  });
});

test('an unusable optional alpha stream preserves valid POV but never swallows cancellation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cs2-native-matte-'));
  const destination = path.join(root, 'matte.mp4'), pov = path.join(root, 'pov.mp4');
  await fs.writeFile(pov, 'actual-native-pov');
  await fs.writeFile(destination, 'incomplete-encoding');
  let warnings = 0, records = 0;
  try {
    assert.equal(await optionalMatte({ source: 'native.mov', destination, encode: async () => { throw new Error('alphaextract rejected input'); }, record: async () => { records++; }, onWarning: () => { warnings++; } }), false);
    assert.equal(await fs.readFile(pov, 'utf8'), 'actual-native-pov');
    await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
    assert.equal(records, 0); assert.equal(warnings, 1);
    const controller = new AbortController(); controller.abort(new Error('user cancelled'));
    await assert.rejects(optionalMatte({ source: 'native.mov', destination, signal: controller.signal, encode: async () => { throw new Error('encoder stopped'); }, record: async () => {} }), /user cancelled/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
