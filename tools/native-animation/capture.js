/* Loaded by HLAE mirv_script_load after the runner prepends its validated plan.
 * Uses the public HLAE 2.192.2+ API. It records engine output, never invents bones.
 * A live CS2/HLAE smoke capture is still required before enabling a render node.
 */
(() => {
  "use strict";
  const plan = globalThis.CS2_NATIVE_CAPTURE_PLAN;
  if (!plan || !plan.clips || !plan.clips.length) throw new Error("Empty native capture plan");
  const id = "cs2-personal-stats/native-capture";
  let recordSequence = 0;
  const emit = (type, data) => {
    // CS2 wraps individual console messages at about 256 bytes. Escape Unicode
    // before base64 encoding, then emit independently indexed short messages.
    const json = JSON.stringify({ type, ...data }).replace(/[\u0080-\uffff]/g, character => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"));
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let encoded = "";
    for (let offset = 0; offset < json.length; offset += 3) {
      const first = json.charCodeAt(offset), second = json.charCodeAt(offset + 1), third = json.charCodeAt(offset + 2);
      encoded += alphabet[first >> 2] + alphabet[((first & 3) << 4) | (Number.isNaN(second) ? 0 : second >> 4)]
        + (Number.isNaN(second) ? "=" : alphabet[((second & 15) << 2) | (Number.isNaN(third) ? 0 : third >> 6)])
        + (Number.isNaN(third) ? "=" : alphabet[third & 63]);
    }
    const parts = Math.ceil(encoded.length / 128);
    if (parts > 256) throw new Error("Native evidence record exceeds transport limit");
    for (let part = 0; part < parts; part++) mirv.message("CS2_NATIVE_PART " + recordSequence + " " + part + "/" + parts + " " + encoded.slice(part * 128, (part + 1) * 128) + "\n");
    recordSequence++;
    if (type === "ready" || type === "complete" || type === "failed") mirv.message("CS2_NATIVE_STATUS " + type + "\n");
  };
  const quote = value => {
    if (/[\r\n\0";]/.test(value)) throw new Error("Unsafe engine path");
    return '"' + value.replace(/\\/g, "/") + '"';
  };
  let clipIndex = 0, phase = "loading", frame = 0, recordElapsed = 0, captureStartTime = null, recordEndTick = null;
  let ownerIndex = null, takeFolder = null, cameraRejected = false;
  const owner = () => {
    for (let index = 1; index <= 64; index++) {
      const controller = mirv.getEntityFromIndex(index);
      if (!controller || !controller.isPlayerController() || String(controller.getSteamId()) !== plan.owner_steamid) continue;
      const handle = controller.getPlayerPawnHandle();
      if (!mirv.isHandleValid(handle)) return null;
      const pawn = mirv.getEntityFromIndex(mirv.getHandleEntryIndex(handle));
      if (!pawn || !pawn.isPlayerPawn()) return null;
      ownerIndex = index;
      return pawn;
    }
    return null;
  };
  const distance = (a, b) => Math.sqrt(a.reduce((sum, value, index) => sum + (value - b[index]) ** 2, 0));
  const angleDelta = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
  const finish = reason => {
    if (phase === "recording" || phase === "stopping") mirv.exec("mirv_streams record end");
    phase = reason === "complete" ? "complete" : "failed";
    emit(phase, { reason, source_sha256: plan.source_sha256, match_id: plan.match_id, clips: clipIndex });
    mirv.events.cViewRenderSetupView.off(id);
    mirv.events.recordStart.off(id);
    mirv.events.recordEnd.off(id);
    mirv.exec("quit");
  };
  const seek = () => {
    const clip = plan.clips[clipIndex];
    frame = 0; recordElapsed = 0; captureStartTime = null; recordEndTick = null; takeFolder = null; cameraRejected = false;
    phase = "seeking";
    mirv.exec("demo_gototick " + clip.preroll_tick);
    mirv.exec("demo_resume");
  };
  mirv.events.recordStart.on(id, event => {
    if (phase !== "starting") { finish("unexpected_stream_start"); return; }
    takeFolder = event.takeFolder;
    phase = "recording";
  });
  mirv.events.recordEnd.on(id, () => {
    if (phase === "failed" || phase === "complete") return;
    if (phase !== "stopping") { finish("unexpected_stream_stop"); return; }
    recordEndTick = mirv.getDemoTick();
    phase = "ending";
  });
  mirv.events.cViewRenderSetupView.on(id, event => {
    if (!mirv.isPlayingDemo() || phase === "failed" || phase === "complete") return;
    const tick = mirv.getDemoTick(), demoTime = mirv.getDemoTime(), renderTime = event.curTime, frameStep = event.absTime;
    if (!Number.isFinite(tick) || !Number.isFinite(demoTime)) return;
    const clip = plan.clips[clipIndex];
    if (phase === "loading") { seek(); return; }
    if (phase === "seeking") {
      // Wait until the requested preroll really loaded; no recording on stale frames.
      if (Math.abs(tick - clip.preroll_tick) > plan.tickrate) return;
      phase = "preroll";
    }
    if (phase === "starting") return;
    if (phase === "ending") {
      // The stream has really stopped. Wait for the engine to leave the planned
      // tick interval before marking this clip complete; retain its actual stop.
      if (tick <= clip.finish_tick) return;
      emit("clip_end", { clip_id: clip.clip_id, tick, time: recordElapsed, time_basis: "record_elapsed_seconds", render_time: renderTime, demo_time: demoTime, frames: frame, start_time: captureStartTime,
        record_end_tick: recordEndTick, take_folder: takeFolder, camera_rejected: cameraRejected });
      clipIndex++;
      if (clipIndex === plan.clips.length) finish("complete"); else seek();
      return;
    }
    const pawn = owner();
    if (!pawn) {
      if (tick >= clip.start_tick) finish("owner_not_alive_or_unresolved");
      return;
    }
    if (phase === "preroll") {
      if (pawn.getHealth() <= 0) { finish("owner_not_alive_at_clip_start"); return; }
      mirv.exec("spec_player " + ownerIndex);
      mirv.exec("spec_mode 1");
      if (tick < clip.start_tick) return;
      const eye = pawn.getRenderEyeOrigin(), angles = pawn.getRenderEyeAngles(), view = event.gameView;
      // Console spectator commands have changed across CS2 builds. Reject a wrong
      // POV instead of accepting another player's video with the requested ID.
      if (distance(eye, [view.x, view.y, view.z]) > 4 || angleDelta(angles[1], view.rY) > 2 || angleDelta(angles[0], view.rX) > 2) {
        cameraRejected = true;
        finish("spectator_camera_not_aligned");
        return;
      }
      mirv.exec("mirv_streams record name " + quote(plan.output_directory + "/clip-" + clip.clip_id));
      phase = "starting";
      mirv.exec("mirv_streams record start");
      return;
    }
    if (phase !== "recording" && phase !== "stopping") return;
    if (!Number.isFinite(renderTime) || !Number.isFinite(frameStep) || frameStep <= 0) {
      finish("invalid_render_clock"); return;
    }
    if (tick > clip.finish_tick) {
      finish("stream_stop_missed_tick_boundary"); return;
    }
    if (captureStartTime === null) {
      if (tick < clip.start_tick || tick > clip.start_tick + 2 || typeof takeFolder !== "string") { finish("stream_start_missed_tick_boundary"); return; }
      captureStartTime = 0;
      emit("clip_start", { clip_id: clip.clip_id, tick, time: captureStartTime, time_basis: "record_elapsed_seconds", render_time: renderTime, demo_time: demoTime, take_folder: takeFolder,
        source_sha256: plan.source_sha256, owner_steamid: plan.owner_steamid, camera_mode: "verified_native_spectator" });
    }
    if (frame > 0) recordElapsed += frameStep;
    const players = [];
    for (let index = 1; index <= 64; index++) {
      const controller = mirv.getEntityFromIndex(index);
      if (!controller || !controller.isPlayerController()) continue;
      const handle = controller.getPlayerPawnHandle();
      if (!mirv.isHandleValid(handle)) continue;
      const actor = mirv.getEntityFromIndex(mirv.getHandleEntryIndex(handle));
      if (!actor || !actor.isPlayerPawn()) continue;
      players.push({ steamid: String(controller.getSteamId()), origin: actor.getOrigin(), health: actor.getHealth() });
    }
    const view = event.gameView;
    // TrueView can move curTime backwards. Stream elapsed time integrates the
    // actual positive engine frame deltas; keep both original clocks as evidence.
    emit("frame", { clip_id: clip.clip_id, frame: frame++, tick,
      time: recordElapsed, time_basis: "record_elapsed_seconds", render_time: renderTime, demo_time: demoTime, frame_step: frameStep,
      camera: { position: [view.x, view.y, view.z], angles: [view.rX, view.rY, view.rZ], fov: view.fov },
      viewport: [event.width, event.height], players });
    if (phase === "recording" && tick >= clip.finish_tick) {
      phase = "stopping";
      mirv.exec("mirv_streams record end");
    }
  });
  mirv.exec("mirv_streams record fps " + plan.fps);
  // HLAE Source 2 accepts only alphanumeric stream names (no underscores).
  mirv.exec("mirv_streams add normal nativePov");
  mirv.exec("mirv_streams edit nativePov capture beforeUi");
  mirv.exec("mirv_streams edit nativePov settings afxFfmpegYuv420p");
  mirv.exec("mirv_streams add playersMatte nativePlayers");
  mirv.exec("mirv_streams edit nativePlayers settings afxFfmpegProresAlpha");
  mirv.exec("mirv_streams record startMovieWav 0");
  mirv.exec("mirv_streams record cam enabled 1");
  emit("ready", { match_id: plan.match_id, source_sha256: plan.source_sha256, fps: plan.fps });
})();
