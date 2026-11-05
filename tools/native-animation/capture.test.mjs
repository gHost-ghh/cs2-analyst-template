import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import vm from "node:vm";

const script = fs.readFileSync(new URL("./capture.js", import.meta.url), "utf8");

test("Windows launcher quoting preserves a nested game command line and waits for a numeric exit code", { skip: process.platform !== "win32" }, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cs2-launch-argv-"));
  const fixture = path.join(temporary, "argv child.mjs"), output = path.join(temporary, "argv.json"), inputs = path.join(temporary, "inputs.json");
  const expected = ["-cmdLine", '-steam -insecure -con_logfile "C:/capture with spaces/engine.log" +mirv_script_load "C:/capture with spaces/capture-job.js" +playdemo "C:/capture with spaces/source.dem"', "", "C:\\trailing\\", "C:\\space dir\\", 'quote"inside', 'slashes\\\\"inside', "中文目录"];
  fs.writeFileSync(fixture, 'import fs from "node:fs"; fs.writeFileSync(process.env.CS2_ARGV_OUTPUT, JSON.stringify(process.argv.slice(2)));');
  fs.writeFileSync(inputs, JSON.stringify(expected));
  const command = `
    $ErrorActionPreference = 'Stop'
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($env:CS2_RUNNER_SOURCE, [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) { throw 'Runner did not parse' }
    $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'ConvertTo-WindowsArgument' }, $true)
    Invoke-Expression $definition.Extent.Text
    $values = @($env:CS2_ARGV_FIXTURE)
    $decoded = Get-Content -LiteralPath $env:CS2_ARGV_INPUTS -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($value in $decoded) { $values += [string]$value }
    $arguments = [string]::Join(' ', @($values | ForEach-Object { ConvertTo-WindowsArgument ([string]$_) }))
    $child = Start-Process -FilePath $env:CS2_ARGV_NODE -ArgumentList $arguments -WindowStyle Hidden -PassThru
    $null = $child.Handle
    if (-not $child.WaitForExit(10000)) { $child.Kill(); throw 'Inert argv probe timed out' }
    $child.Refresh()
    if ($null -eq $child.ExitCode -or $child.ExitCode -isnot [int] -or $child.ExitCode -ne 0) { throw 'Missing or invalid child exit code' }
    $child.Dispose()
  `;
  try {
    const result = spawnSync(path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoLogo", "-NoProfile", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], {
      windowsHide: true, encoding: "utf8", timeout: 20000,
      env: { ...process.env, CS2_RUNNER_SOURCE: fileURLToPath(new URL("./run-capture.ps1", import.meta.url)), CS2_ARGV_NODE: process.execPath, CS2_ARGV_FIXTURE: fixture, CS2_ARGV_INPUTS: inputs, CS2_ARGV_OUTPUT: output },
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), expected);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

function setup({ camera = [0, 0, 64], ownerFound = true, dead = false, outputDirectory = "C:/private/output" } = {}) {
  const listeners = new Map(), commands = [], records = [], streams = new Set(), messages = [];
  let pending = [], sequence = 0;
  const source = name => ({ on: (id, handler) => listeners.set(name, handler), off: () => listeners.delete(name) });
  let health = dead ? 0 : 100;
  const actor = { isPlayerPawn: () => true, getHealth: () => health, getOrigin: () => [0, 0, 0],
    getRenderEyeOrigin: () => [0, 0, 64], getRenderEyeAngles: () => [0, 90, 0] };
  const controller = { isPlayerController: () => true, getSteamId: () => 76561198000000000n, getPlayerPawnHandle: () => 99 };
  let tick = 0, time = 0, renderTime = 0, pendingStart = false, pendingEnd = false;
  const mirv = {
    exec: command => {
      commands.push(command);
      const add = /^mirv_streams add \S+ (\S+)$/.exec(command);
      if (add) {
        // Mirror the pinned engine's Console_CheckStreamName / StringIsAlNum.
        assert.match(add[1], /^[A-Za-z0-9]+$/, "HLAE rejects non-alphanumeric stream names");
        streams.add(add[1]);
      }
      const edit = /^mirv_streams edit (\S+) /.exec(command);
      if (edit) assert.ok(streams.has(edit[1]), "Cannot edit a stream HLAE did not create");
      if (command === "mirv_streams record start") pendingStart = true;
      if (command === "mirv_streams record end") pendingEnd = true;
    },
    message: value => {
      messages.push(value);
      if (value.startsWith("CS2_NATIVE_STATUS ")) return;
      const match = /^CS2_NATIVE_PART (\d+) (\d+)\/(\d+) ([A-Za-z0-9+/=]{1,128})\n$/.exec(value);
      assert.ok(match, "Evidence message must be a bounded indexed chunk");
      assert.equal(Number(match[1]), sequence);
      assert.equal(Number(match[2]), pending.length);
      pending.push(match[4]);
      if (pending.length === Number(match[3])) {
        records.push(JSON.parse(Buffer.from(pending.join(""), "base64").toString("utf8")));
        pending = []; sequence++;
      }
    },
    getEntityFromIndex: index => index === 1 && ownerFound ? controller : index === 99 ? actor : null,
    getHandleEntryIndex: value => value, isHandleValid: value => value > 0,
    isPlayingDemo: () => true, getDemoTick: () => tick, getDemoTime: () => time,
    events: { recordStart: source("recordStart"), recordEnd: source("recordEnd"), cViewRenderSetupView: source("view") },
  };
  const plan = { owner_steamid: "76561198000000000", match_id: "a".repeat(24), source_sha256: "b".repeat(64),
    tickrate: 64, fps: 120, output_directory: outputDirectory, clips: [
      { clip_id: "000", start_tick: 1000, finish_tick: 1128, preroll_tick: 808 },
    ] };
  vm.runInNewContext(script, { mirv, CS2_NATIVE_CAPTURE_PLAN: plan });
  function frame(at, seconds = at / 64, renderSeconds = renderTime + 1 / 120, frameStep = 1 / 120) {
    tick = at; time = seconds; renderTime = renderSeconds;
    if (pendingStart) { pendingStart = false; listeners.get("recordStart")?.({ takeFolder: "C:/private/take0000" }); }
    if (pendingEnd) { pendingEnd = false; listeners.get("recordEnd")?.({}); }
    listeners.get("view")?.({ curTime: renderTime, absTime: frameStep, gameView: { x: camera[0], y: camera[1], z: camera[2], rX: 0, rY: 90, rZ: 0, fov: 90 }, width: 1920, height: 1080 });
  }
  return { commands, records, streams, messages, frame, setHealth: value => { health = value; } };
}

test("long evidence records survive bounded console transport without dropping JSON fields", () => {
  const harness = setup({ outputDirectory: "C:/用户/原生回放" });
  harness.frame(0); harness.frame(808); harness.frame(1000); harness.frame(1000); harness.frame(1128); harness.frame(1129);
  assert.ok(harness.messages.every(value => value.length < 200));
  assert.ok(harness.messages.some(value => /^CS2_NATIVE_PART \d+ 1\//.test(value)));
  const row = harness.records.find(value => value.type === "frame");
  assert.equal(row.players[0].steamid, "76561198000000000");
  assert.equal(row.viewport[0], 1920);
  assert.equal(harness.records.at(-1).type, "complete");
});

test("capture creates both streams using names accepted by the pinned HLAE engine", () => {
  const harness = setup();
  assert.deepEqual([...harness.streams], ["nativePov", "nativePlayers"]);
});

test("engine capture warms up, verifies owner POV, logs frames, and finishes", () => {
  const harness = setup();
  harness.frame(0); harness.frame(808); harness.frame(1000);
  assert.equal(harness.records.filter(value => value.type === "frame").length, 0, "Queued start must not claim an uncaptured frame");
  harness.frame(1000); harness.frame(1000); harness.frame(1001); harness.frame(1128);
  assert.ok(!harness.records.some(value => value.type === "clip_end"), "Queued stop must wait for real recordEnd");
  harness.frame(1129);
  assert.equal(harness.commands.filter(value => value === "mirv_streams record start").length, 1);
  assert.equal(harness.commands.filter(value => value === "mirv_streams record end").length, 1);
  const frames = harness.records.filter(value => value.type === "frame");
  assert.equal(frames.length, 4);
  assert.equal(frames[0].players[0].steamid, "76561198000000000");
  assert.equal(frames[0].tick, 1000);
  assert.equal(frames[0].demo_time, frames[1].demo_time);
  assert.ok(frames[1].time > frames[0].time, "Distinct native renders on the same tick must remain distinct");
  assert.equal(frames[0].time, 0);
  assert.equal(frames[0].time_basis, "record_elapsed_seconds");
  assert.equal(frames[1].time, frames[1].frame_step);
  assert.equal(harness.records.find(value => value.type === "clip_start").take_folder, "C:/private/take0000");
  assert.equal(harness.records.at(-1).type, "complete");
});

test("an untrustworthy render clock fails instead of synthesizing or dropping frames", () => {
  const harness = setup();
  harness.frame(0); harness.frame(808); harness.frame(1000);
  harness.frame(1000, 1000 / 64, 42); harness.frame(1000, 1000 / 64, 42, 0);
  assert.equal(harness.records.at(-1).reason, "invalid_render_clock");
});

test("TrueView clock reversals retain every render and its raw clocks", () => {
  const harness = setup();
  harness.frame(0); harness.frame(808); harness.frame(1000);
  harness.frame(1000, 1000 / 64, 73.49, .008333);
  harness.frame(1000, 1000 / 64, 73.485, .008333);
  const frames = harness.records.filter(value => value.type === "frame");
  assert.equal(frames.length, 2);
  assert.ok(frames[1].render_time < frames[0].render_time);
  assert.equal(frames[0].demo_time, frames[1].demo_time);
  assert.equal(frames[1].time - frames[0].time, frames[1].frame_step);
});

test("wrong spectator camera rejects capture without producing a mislabeled video", () => {
  const harness = setup({ camera: [1000, 1000, 64] });
  harness.frame(0); harness.frame(808); harness.frame(1000);
  assert.ok(!harness.commands.includes("mirv_streams record start"));
  assert.equal(harness.records.at(-1).reason, "spectator_camera_not_aligned");
});

test("missing owner fails and post-shot death may remain in native footage", () => {
  const missing = setup({ ownerFound: false });
  missing.frame(0); missing.frame(808); missing.frame(1000);
  assert.equal(missing.records.at(-1).reason, "owner_not_alive_or_unresolved");
  const death = setup();
  death.frame(0); death.frame(808); death.frame(1000); death.frame(1000); death.setHealth(0); death.frame(1001); death.frame(1128); death.frame(1129);
  assert.equal(death.records.at(-1).type, "complete");
});
