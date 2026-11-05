import { createHash } from 'node:crypto';

export const VERSION = '1.0';
export const PORT = 43187;
export const PART_BYTES = 262144;
export const CLOUD_ORIGINS = new Set([
  'https://your-site.example', 'https://your-site.example',
]);
export const SHA256 = /^[a-f0-9]{64}$/;
export const JOB_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const SAFE_ID = /^[a-zA-Z0-9_-]{1,80}$/;
export const MAX_DEMO_BYTES = 3 * 1024 ** 3;
export const MAX_MEDIA_BYTES = 256 * 1024 ** 2;
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const integer = (value, low, high) => Number.isSafeInteger(value) && value >= low && value <= high;

export function parseLaunchUri(value) {
  requireValue(typeof value === 'string' && value.length <= 512 && !/[\u0000-\u0020\u007f]/.test(value), 'Invalid local render URI');
  const url = new URL(value);
  requireValue(url.protocol === 'cs2lab:' && url.hostname === 'render' && (!url.pathname || url.pathname === '/') && !url.hash && !url.username && !url.password && !url.port, 'Invalid local render URI');
  requireValue([...url.searchParams.keys()].sort().join(',') === 'nonce,origin', 'Unexpected local render parameters');
  const origin = url.searchParams.get('origin'), nonce = url.searchParams.get('nonce');
  requireValue(CLOUD_ORIGINS.has(origin) && SHA256.test(nonce), 'Unapproved website or invalid one-time nonce');
  return { origin, nonce };
}

export function validateDemoUrl(value) {
  requireValue(typeof value === 'string' && value.length <= 2048 && !/[\u0000-\u0020\u007f]/.test(value), 'Demo URL required');
  const url = new URL(value);
  requireValue(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash && !url.search && !url.port, 'Invalid Demo URL');
  requireValue(/^replay[0-9]+\.(?:valve\.net|wmsj\.cn|csgo\.com\.cn)$/.test(url.hostname), 'Demo must come from an approved replay host');
  requireValue(/^\/730\/[a-zA-Z0-9_.-]+\.dem(?:\.bz2)?$/.test(url.pathname) && !url.pathname.includes('..'), 'Invalid replay path');
  return url;
}

export function validateJob(value) {
  requireValue(value && JOB_ID.test(value.job_id), 'Invalid render job ID');
  const plan = value.plan, demo = value.demo;
  requireValue(plan?.kind === 'cs2_engine_capture_plan' && /^[a-f0-9]{24}$/.test(plan.match_id), 'Invalid capture plan');
  requireValue(/^7656119[0-9]{10}$/.test(plan.owner_steamid) && SHA256.test(plan.source_sha256), 'Invalid source identity');
  requireValue(integer(plan.fps, 30, 240) && Number.isFinite(plan.tickrate) && plan.tickrate >= 16 && plan.tickrate <= 256, 'Invalid capture frame rate');
  requireValue(Array.isArray(plan.clips) && plan.clips.length >= 1 && plan.clips.length <= 16, 'Capture must contain 1–16 clips');
  let totalSeconds = 0;
  const seen = new Set();
  const clips = plan.clips.map(clip => {
    requireValue(clip && SAFE_ID.test(clip.clip_id) && !seen.has(clip.clip_id), 'Invalid or duplicate clip ID');
    seen.add(clip.clip_id);
    requireValue(integer(clip.start_tick, 0, 100000000) && integer(clip.finish_tick, clip.start_tick + 1, clip.start_tick + Math.ceil(20 * plan.tickrate)), 'Invalid clip tick range');
    requireValue(integer(clip.preroll_tick, Math.max(0, clip.start_tick - Math.ceil(10 * plan.tickrate)), clip.start_tick), 'Invalid clip warm-up');
    requireValue(typeof clip.burst_id === 'string' && clip.burst_id.length <= 128 && !/[\u0000-\u001f]/.test(clip.burst_id), 'Invalid burst ID');
    requireValue(Array.isArray(clip.shot_ticks) && clip.shot_ticks.length > 0 && clip.shot_ticks.length <= 256 && clip.shot_ticks.every(t => integer(t, clip.start_tick, clip.finish_tick)), 'Observed shot ticks required');
    totalSeconds += (clip.finish_tick - clip.start_tick) / plan.tickrate;
    return { clip_id: clip.clip_id, burst_id: clip.burst_id, start_tick: clip.start_tick, finish_tick: clip.finish_tick, preroll_tick: clip.preroll_tick, shot_ticks: [...new Set(clip.shot_ticks)], target_steamids: (clip.target_steamids ?? []).filter(id => /^7656119[0-9]{10}$/.test(id)).slice(0, 10) };
  });
  requireValue(totalSeconds <= 180, 'Capture duration exceeds 180 seconds');
  requireValue(demo && demo.sha256 === plan.source_sha256 && ['none', 'bz2'].includes(demo.compression), 'Verified Demo identity required');
  if (demo.url) validateDemoUrl(demo.url);
  requireValue(demo.bytes == null || integer(demo.bytes, 1, MAX_DEMO_BYTES), 'Invalid source Demo size');
  return {
    job_id: value.job_id,
    plan: { kind: plan.kind, version: VERSION, match_id: plan.match_id, owner_steamid: plan.owner_steamid, source_sha256: plan.source_sha256, tickrate: plan.tickrate, fps: plan.fps, clips, expected_demo_build: typeof plan.expected_demo_build === 'string' || Number.isSafeInteger(plan.expected_demo_build) ? plan.expected_demo_build : null },
    demo: { url: demo.url || null, sha256: demo.sha256, compression: demo.compression, bytes: demo.bytes ?? null },
  };
}

export function artifactId(clipId, kind) {
  const id = `${clipId}_${kind}`;
  requireValue(/^[a-z0-9_-]{1,80}$/.test(id) && ['pov', 'matte', 'evidence'].includes(kind), 'Invalid native artifact ID');
  return id;
}

export function evidenceForClip(lines, job, clip) {
  requireValue(Array.isArray(lines) && lines.length <= 100000, 'Invalid native evidence');
  const end = lines.find(row => row.type === 'complete');
  requireValue(end && end.source_sha256 === job.plan.source_sha256 && end.match_id === job.plan.match_id && end.clips === job.plan.clips.length, 'Native capture did not finish completely');
  const rows = lines.filter(row => row.clip_id === clip.clip_id);
  const start = rows.find(row => row.type === 'clip_start'), finish = rows.find(row => row.type === 'clip_end');
  const frames = rows.filter(row => row.type === 'frame');
  requireValue(start?.source_sha256 === job.plan.source_sha256 && start.owner_steamid === job.plan.owner_steamid && start.camera_mode === 'verified_native_spectator', 'Native view identity was not verified');
  requireValue(finish && finish.camera_rejected === false && frames.length > 0 && finish.frames === frames.length, 'Native capture is missing frame evidence');
  requireValue(start.tick >= clip.start_tick && start.tick <= clip.start_tick + 2 && finish.tick > clip.finish_tick && finish.tick <= clip.finish_tick + 4, 'Native clip tick coverage differs from its plan');
  requireValue(frames[0].tick <= clip.start_tick + 2 && frames.at(-1).tick >= clip.finish_tick - 1, 'Native frame coverage does not span the full clip');
  for (let index = 0; index < frames.length; index++) {
    const row = frames[index];
    requireValue(row.frame === index && Number.isFinite(row.time) && integer(row.tick, clip.start_tick, clip.finish_tick) && Array.isArray(row.camera?.position) && row.camera.position.length === 3 && row.camera.position.every(Number.isFinite), 'Invalid native frame alignment');
    requireValue(index === 0 || row.time > frames[index - 1].time, 'Native evidence time must increase');
    requireValue(index === 0 || (row.tick >= frames[index - 1].tick && row.tick - frames[index - 1].tick <= Math.ceil(job.plan.tickrate / job.plan.fps) + 1), 'Native tick coverage contains a gap');
  }
  return [...rows, end];
}

export function validateVideoProbe(value, plan, frameCount) {
  const video = value?.streams?.find(stream => stream.codec_type === 'video');
  const rate = video?.avg_frame_rate?.split('/').map(Number);
  requireValue(video?.codec_name === 'h264' && integer(video.width, 320, 3840) && integer(video.height, 240, 2160), 'Unsupported native playback video');
  requireValue(rate?.length === 2 && rate[1] > 0 && Math.abs(rate[0] / rate[1] - plan.fps) < 0.01, 'Native video frame rate differs from its plan');
  const count = Number(video.nb_read_frames ?? video.nb_frames), duration = Number(video.duration ?? value.format?.duration);
  requireValue(integer(count, 1, 50000) && count === frameCount && Number.isFinite(duration) && Math.abs(duration - count / plan.fps) <= 0.05, 'Native video and engine evidence do not align');
  return { codec_name: video.codec_name, width: video.width, height: video.height, avg_frame_rate: video.avg_frame_rate, nb_frames: count, duration };
}
