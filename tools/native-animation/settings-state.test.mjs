import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const windows = process.platform === 'win32';
const source = fileURLToPath(new URL('./settings-state.ps1', import.meta.url));
function fixture(command) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cs2-settings-transaction-'));
  try {
    const environment = { ...process.env, CS2_SETTINGS_SOURCE: source, CS2_SETTINGS_FIXTURE: directory };
    for (const name of Object.keys(environment)) if (name.toLowerCase() === 'psmodulepath') delete environment[name];
    const result = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-EncodedCommand', Buffer.from(`$ErrorActionPreference = 'Stop'\n. $env:CS2_SETTINGS_SOURCE\n${command}`, 'utf16le').toString('base64')], {
      encoding: 'utf8', windowsHide: true, timeout: 20000,
      env: environment,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout.trim();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test('CS2 settings transaction restores exact bytes, timestamp and attributes, removes only new known files', { skip: !windows }, () => {
  assert.equal(fixture(`
    $cfg = Join-Path $env:CS2_SETTINGS_FIXTURE 'cfg'; New-Item -ItemType Directory -Path $cfg | Out-Null
    $original = Join-Path $cfg 'cs2_video.txt'; $shadow = Join-Path $cfg 'cs2_user_convars_0_slot0.vcfg_lastclouded'
    [IO.File]::WriteAllBytes($original, [byte[]](255, 0, 123, 13, 10, 0, 254))
    [IO.File]::WriteAllText($shadow, 'private original')
    $unchanged = Join-Path $cfg 'cs2_machine_convars.vcfg'; [IO.File]::WriteAllText($unchanged, 'untouched while protected')
    $originalTime = New-Object DateTime(638000000000000000, [DateTimeKind]::Utc)
    [IO.File]::SetLastWriteTimeUtc($original, $originalTime); [IO.File]::SetAttributes($original, [IO.FileAttributes]::ReadOnly)
    [IO.File]::WriteAllText((Join-Path $cfg 'unknown.cfg'), 'keep unknown')
    $state = Save-CaptureSettings @{ cfg = $cfg } (Join-Path $env:CS2_SETTINGS_FIXTURE 'backup')
    if ($state.status -ne 'pending') { throw 'No pending backup' }
    Protect-CaptureSettings $state {}
    if (-not ([IO.File]::GetAttributes($shadow) -band [IO.FileAttributes]::ReadOnly)) { throw 'Capture write protection missing' }
    if ([IO.File]::GetAttributes((Join-Path $cfg 'unknown.cfg')) -band [IO.FileAttributes]::ReadOnly) { throw 'Unknown file was protected' }
    [IO.File]::SetAttributes($original, [IO.FileAttributes]::Normal)
    [IO.File]::WriteAllText($original, 'changed by fixture capture'); Remove-Item -LiteralPath $shadow -Force
    [IO.File]::WriteAllText((Join-Path $cfg 'cs2_user_keys_0_slot1.vcfg'), 'new engine file')
    [IO.File]::WriteAllText((Join-Path $cfg 'new-unknown.cfg'), 'keep new unknown')
    $script:safeCalls = 0
    Restore-CaptureSettings $state { $script:safeCalls++ }
    if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($original)) -ne '/wB7DQoA/g==') { throw 'Original bytes changed' }
    if ([IO.File]::GetLastWriteTimeUtc($original).Ticks -ne $originalTime.Ticks) { throw 'Timestamp changed' }
    if (-not ([IO.File]::GetAttributes($original) -band [IO.FileAttributes]::ReadOnly)) { throw 'Read-only attribute lost' }
    if ([IO.File]::ReadAllText($shadow) -ne 'private original') { throw 'Shadow file not restored' }
    if ([IO.File]::GetAttributes($shadow) -band [IO.FileAttributes]::ReadOnly) { throw 'Temporary read-only attribute persisted' }
    if ([IO.File]::ReadAllText($unchanged) -ne 'untouched while protected' -or ([IO.File]::GetAttributes($unchanged) -band [IO.FileAttributes]::ReadOnly)) { throw 'Unchanged protected config was not restored' }
    if (Test-Path -LiteralPath (Join-Path $cfg 'cs2_user_keys_0_slot1.vcfg')) { throw 'Originally absent engine file was retained' }
    if ([IO.File]::ReadAllText((Join-Path $cfg 'unknown.cfg')) -ne 'keep unknown' -or [IO.File]::ReadAllText((Join-Path $cfg 'new-unknown.cfg')) -ne 'keep new unknown') { throw 'Unknown file modified' }
    if ($script:safeCalls -lt 4 -or $state.status -ne 'pending') { throw 'Missing safety checks or premature completion' }
    Complete-CaptureSettings $state
    if ((Get-Content -LiteralPath (Join-Path $state.backup_directory 'state.json') -Raw | ConvertFrom-Json).status -ne 'restored') { throw 'Completion not persisted' }
    'ok'
  `), 'ok');
});

test('unsafe restore guard and corrupt backup leave changed settings untouched and transaction pending', { skip: !windows }, () => {
  assert.equal(fixture(`
    $cfg = Join-Path $env:CS2_SETTINGS_FIXTURE 'cfg'; New-Item -ItemType Directory -Path $cfg | Out-Null
    $file = Join-Path $cfg 'cs2_video.txt'; [IO.File]::WriteAllText($file, 'original')
    $state = Save-CaptureSettings @{ cfg = $cfg } (Join-Path $env:CS2_SETTINGS_FIXTURE 'backup')
    [IO.File]::WriteAllText($file, 'capture')
    $blocked = $false; try { Restore-CaptureSettings $state { throw 'other game active' } } catch { $blocked = $true }
    if (-not $blocked -or [IO.File]::ReadAllText($file) -ne 'capture' -or $state.status -ne 'pending') { throw 'Unsafe restore ran' }
    [IO.File]::WriteAllText((Join-Path $state.backup_directory 'cs2_video.txt'), 'corrupt')
    $blocked = $false; try { Restore-CaptureSettings $state {} } catch { $blocked = $true }
    if (-not $blocked -or [IO.File]::ReadAllText($file) -ne 'capture' -or $state.status -ne 'pending') { throw 'Corrupt backup restored' }
    'ok'
  `), 'ok');
});

test('settings scope excludes global Steam metadata, autoexec and arbitrary files', { skip: !windows }, () => {
  assert.equal(fixture(`
    foreach ($name in @('cs2_video.txt', 'CS2_VIDEO.TXT', 'cs2_machine_convars.vcfg', 'cs2_user_keys_0_slot3.vcfg', 'cs2_user_convars_0_slot0.vcfg_lastclouded')) { if (-not (Test-CaptureSettingName $name)) { throw 'Expected local setting excluded' } }
    foreach ($name in @('sharedconfig.vdf', 'remotecache.vdf', 'autoexec.cfg', 'trustedlaunch.cfg', '../cs2_video.txt', 'cs2_video.txt.bak', 'cs2_user_keys_0_slot4.vcfg')) { if (Test-CaptureSettingName $name) { throw 'Unexpected file included' } }
    'ok'
  `), 'ok');
});

test('pending settings marker blocks a new baseline and is removed only on completed restoration', { skip: !windows }, () => {
  assert.equal(fixture(`
    $cfg = Join-Path $env:CS2_SETTINGS_FIXTURE 'cfg'; New-Item -ItemType Directory -Path $cfg | Out-Null
    [IO.File]::WriteAllText((Join-Path $cfg 'cs2_video.txt'), 'original')
    $marker = Join-Path $env:CS2_SETTINGS_FIXTURE 'pending.json'
    $state = Save-CaptureSettings @{ cfg = $cfg } (Join-Path $env:CS2_SETTINGS_FIXTURE 'backup') $marker
    $blocked = $false; try { Save-CaptureSettings @{ cfg = $cfg } (Join-Path $env:CS2_SETTINGS_FIXTURE 'other-backup') $marker } catch { $blocked = $true }
    if (-not $blocked -or -not (Test-Path -LiteralPath $marker)) { throw 'Pending transaction overwritten' }
    Restore-CaptureSettings $state {}
    Complete-CaptureSettings $state
    if (Test-Path -LiteralPath $marker) { throw 'Completed marker not cleared' }
    'ok'
  `), 'ok');
});

test('prelaunch changes and cancellation preserve external bytes and undo only applied read-only protection', { skip: !windows }, () => {
  assert.equal(fixture(`
    $cfg = Join-Path $env:CS2_SETTINGS_FIXTURE 'cfg'; New-Item -ItemType Directory -Path $cfg | Out-Null
    $video = Join-Path $cfg 'cs2_video.txt'; $machine = Join-Path $cfg 'cs2_machine_convars.vcfg'
    [IO.File]::WriteAllText($video, 'original video'); [IO.File]::WriteAllText($machine, 'original machine')
    $state = Save-CaptureSettings @{ cfg = $cfg } (Join-Path $env:CS2_SETTINGS_FIXTURE 'backup-before-edit')
    [IO.File]::WriteAllText($video, 'legitimate edit before launch')
    $blocked = $false; try { Protect-CaptureSettings $state {} } catch { $blocked = $true }
    if (-not $blocked -or -not (Undo-CaptureSettingsProtection $state)) { throw 'Prelaunch edit was not rejected safely' }
    Complete-CaptureSettings $state 'not_started'
    if ([IO.File]::ReadAllText($video) -ne 'legitimate edit before launch') { throw 'Prelaunch external edit was rolled back' }
    $state = Save-CaptureSettings @{ cfg = $cfg } (Join-Path $env:CS2_SETTINGS_FIXTURE 'backup-before-cancel')
    $script:preflight = 0
    $blocked = $false; try { Protect-CaptureSettings $state { $script:preflight++; if ($script:preflight -eq 3) { throw 'cancel during protection' } } } catch { $blocked = $true }
    if (-not $blocked -or $state.protected_names.Count -ne 1) { throw 'Partial protection cancellation fixture failed' }
    if (-not (Undo-CaptureSettingsProtection $state)) { throw 'Partial protection not removed' }
    foreach ($file in @($video, $machine)) { if ([IO.File]::GetAttributes($file) -band [IO.FileAttributes]::ReadOnly) { throw 'Read-only flag leaked after cancellation' } }
    if ([IO.File]::ReadAllText($video) -ne 'legitimate edit before launch' -or [IO.File]::ReadAllText($machine) -ne 'original machine') { throw 'Cancellation changed user settings bytes' }
    'ok'
  `), 'ok');
});

test('PowerShell runner cancellation detects an exited helper and keeps cleanup independent', { skip: !windows }, () => {
  assert.equal(fixture(`
    $runner = Join-Path (Split-Path -Parent $env:CS2_SETTINGS_SOURCE) 'run-capture.ps1'
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($runner, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw 'Runner parse failed' }
    $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-CaptureNotCancelled' }, $true)
    Invoke-Expression $definition.Extent.Text
    $CancellationFile = ''; $ParentNodeProcessId = $PID; $parentNodeStartTicks = (Get-Process -Id $PID).StartTime.Ticks
    Assert-CaptureNotCancelled
    $ParentNodeProcessId = [int]::MaxValue
    $blocked = $false; try { Assert-CaptureNotCancelled } catch { $blocked = $true }
    if (-not $blocked) { throw 'Missing parent exit cancellation' }
    'ok'
  `), 'ok');
});
