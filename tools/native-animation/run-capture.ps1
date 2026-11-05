param(
    [Parameter(Mandatory=$true)][string]$Plan,
    [Parameter(Mandatory=$true)][string]$Demo,
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [Parameter(Mandatory=$true)][string]$HlaeDirectory,
    [Parameter(Mandatory=$true)][string]$Cs2Executable,
    [int]$TimeoutMinutes = 30,
    [string]$CancellationFile = '',
    [int]$ParentNodeProcessId = 0
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'settings-state.ps1')
function ConvertTo-WindowsArgument([string]$Value) {
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
    # CommandLineToArgvW: double backslashes before quotes and the closing quote.
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}
$capturePlan = Get-Content -LiteralPath $Plan -Raw | ConvertFrom-Json
if ($capturePlan.kind -ne 'cs2_engine_capture_plan' -or $capturePlan.clips.Count -lt 1) { throw 'Invalid or empty native capture plan' }
if ($capturePlan.PSObject.Properties.Name -contains 'output_directory') { throw 'Output directory is controlled by the installed runner' }
foreach ($clip in $capturePlan.clips) {
    if ($clip.clip_id -notmatch '^[a-zA-Z0-9_-]{1,64}$' -or $clip.start_tick -lt 0 -or $clip.finish_tick -le $clip.start_tick -or $clip.preroll_tick -gt $clip.start_tick) { throw 'Invalid native clip identity or tick range' }
}
if ($capturePlan.source_sha256 -ne (Get-FileHash -LiteralPath $Demo -Algorithm SHA256).Hash.ToLowerInvariant()) { throw 'Demo SHA-256 does not match capture plan' }
if ($TimeoutMinutes -lt 1 -or $TimeoutMinutes -gt 120) { throw 'Capture timeout must be 1–120 minutes' }
if (Get-Process cs2 -ErrorAction SilentlyContinue) { throw 'CS2 is already running on the render node' }
$hlae = Join-Path $HlaeDirectory 'HLAE.exe'
$hook = Join-Path $HlaeDirectory 'x64/AfxHookSource2.dll'
foreach ($file in @($hlae, $hook, $Cs2Executable, $Demo)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Required native render file missing: $file" }
    if ($file -match '[";\r\n\x00]') { throw 'Unsafe character in engine path' }
}
$Cs2Executable = (Resolve-Path -LiteralPath $Cs2Executable).Path
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Capture output directory must be new' }
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
$OutputDirectory = (Resolve-Path -LiteralPath $OutputDirectory).Path
if ($OutputDirectory -match '[";\r\n\x00]') { throw 'Unsafe character in capture output path' }
$capturePlan | Add-Member -NotePropertyName output_directory -NotePropertyValue $OutputDirectory
$script = Join-Path $OutputDirectory 'capture-job.js'
$log = Join-Path $OutputDirectory 'engine.log'
$prefix = 'globalThis.CS2_NATIVE_CAPTURE_PLAN = ' + ($capturePlan | ConvertTo-Json -Depth 32 -Compress) + ';' + [Environment]::NewLine
[IO.File]::WriteAllText($script, $prefix + [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'capture.js')))
$scriptEngine = $script.Replace('\', '/')
$logEngine = $log.Replace('\', '/')
$demoEngine = (Resolve-Path -LiteralPath $Demo).Path.Replace('\', '/')
$launch = '-steam -insecure -perfectworld -novid -windowed -w 1920 -h 1080 -console -con_logfile "' + $logEngine + '" +version +mirv_script_load "' + $scriptEngine + '" +playdemo "' + $demoEngine + '"'
$launcherArguments = [string]::Join(' ', @(@('-customLoader', '-autoStart', '-noGui', '-hookDllPath', $hook, '-programPath', $Cs2Executable, '-cmdLine', $launch, '-addEnv', 'SteamAppId=730', '-addEnv', 'SteamGameId=730') | ForEach-Object { ConvertTo-WindowsArgument $_ }))
$startedAt = Get-Date
$hlaeProcess = $null
$ownedProcessId = $null
$ownedStartTicks = $null
$completed = $false
$captureSucceeded = $false
$launchAttempted = $false
$settings = $null
$settingsLock = $null
$settingsLockHeld = $false
$parentNodeStartTicks = $null
if ($ParentNodeProcessId -gt 0) {
    $parentNode = Get-Process -Id $ParentNodeProcessId -ErrorAction Stop
    $parentNodeStartTicks = $parentNode.StartTime.Ticks
}
function Assert-CaptureNotCancelled {
    if ($CancellationFile -and (Test-Path -LiteralPath $CancellationFile -PathType Leaf)) { throw 'Local render cancelled; restoring original CS2 settings' }
    if ($ParentNodeProcessId -gt 0) {
        $parentNode = Get-Process -Id $ParentNodeProcessId -ErrorAction SilentlyContinue
        if (-not $parentNode -or $parentNode.StartTime.Ticks -ne $parentNodeStartTicks) { throw 'Local helper exited; restoring original CS2 settings' }
    }
}
function Get-CaptureCs2Process {
    if ($null -ne $ownedProcessId) {
        $known = Get-Process -Id $ownedProcessId -ErrorAction SilentlyContinue
        if ($known -and $known.StartTime.Ticks -eq $ownedStartTicks -and $known.Path -eq $Cs2Executable) { return $known }
        return $null
    }
    if ($null -eq $hlaeProcess) { return $null }
    # Parent PID proves this is HLAE's child, rather than a user opening Steam
    # during the launch window. Retain exact PID/start time after discovery.
    $children = @(Get-CimInstance Win32_Process -Filter "Name = 'cs2.exe'" | Where-Object { $_.ParentProcessId -eq $hlaeProcess.Id -and $_.ExecutablePath -eq $Cs2Executable })
    $candidates = @($children | ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } | Where-Object { $_.StartTime -ge $startedAt.AddSeconds(-2) -and $_.Path -eq $Cs2Executable })
    if ($candidates.Count -gt 1) { throw 'More than one CS2 client was started by the capture launcher' }
    if ($candidates.Count -eq 1) { return $candidates[0] }
    return $null
}
try {
    Assert-CaptureNotCancelled
    $settingsContext = Get-CaptureSettingsContext $Cs2Executable
    $settingsHash = [Security.Cryptography.SHA256]::Create()
    try { $lockId = [BitConverter]::ToString($settingsHash.ComputeHash([Text.Encoding]::UTF8.GetBytes($settingsContext.cfg.ToLowerInvariant()))).Replace('-', '') } finally { $settingsHash.Dispose() }
    $settingsLock = New-Object Threading.Mutex($false, ('Local\CS2DemoLabSettings-' + $lockId))
    try { $settingsLockHeld = $settingsLock.WaitOne(0) } catch [Threading.AbandonedMutexException] { $settingsLockHeld = $true }
    if (-not $settingsLockHeld) { throw 'Another native capture is protecting CS2 settings' }
    if (Get-Process cs2 -ErrorAction SilentlyContinue) { throw 'CS2 started before capture; close it and retry' }
    Assert-CaptureSteamUser $settingsContext
    $markerDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'CS2DemoLab/settings-transactions'
    Assert-CapturePlainPath $markerDirectory
    New-Item -ItemType Directory -Path $markerDirectory -Force | Out-Null
    $backupRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'CS2DemoLab/settings-backups'
    Assert-CapturePlainPath $backupRoot
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    $settings = Save-CaptureSettings $settingsContext (Join-Path $backupRoot ([Guid]::NewGuid().ToString('N'))) (Join-Path $markerDirectory ($lockId + '.json'))
    Protect-CaptureSettings $settings {
        Assert-CaptureNotCancelled
        Assert-CaptureSteamUser $settingsContext
        if (Get-Process cs2 -ErrorAction SilentlyContinue) { throw 'Another CS2 session started before capture' }
    }
    Assert-CaptureNotCancelled
    Assert-CaptureSteamUser $settingsContext
    if (Get-Process cs2 -ErrorAction SilentlyContinue) { throw 'Another CS2 session started; original settings backup retained without launching capture' }
    $launchAttempted = $true
    $hlaeProcess = Start-Process -FilePath $hlae -ArgumentList $launcherArguments -WindowStyle Hidden -PassThru
    # Retain the native handle before waiting, so ExitCode remains available
    # even when this GUI launcher exits before the first process poll.
    $null = $hlaeProcess.Handle
    $startupDeadline = (Get-Date).AddSeconds(30)
    do {
        Assert-CaptureNotCancelled
        $running = Get-CaptureCs2Process
        if ($running -and $null -eq $ownedProcessId) { $ownedProcessId = $running.Id; $ownedStartTicks = $running.StartTime.Ticks }
        if ($hlaeProcess.WaitForExit(200)) { break }
        if ((Get-Date) -gt $startupDeadline) { throw 'HLAE launcher startup timed out after 30 seconds' }
    } while ($true)
    $hlaeProcess.Refresh()
    $launcherExitCode = $hlaeProcess.ExitCode
    if ($null -eq $launcherExitCode -or $launcherExitCode -isnot [int] -or $launcherExitCode -ne 0) { throw "HLAE could not launch the offline CS2 client (exit code: $launcherExitCode)" }
    $deadline = $startedAt.AddMinutes($TimeoutMinutes)
    do {
        Start-Sleep -Seconds 2
        Assert-CaptureNotCancelled
        $running = Get-CaptureCs2Process
        if ($running -and $null -eq $ownedProcessId) { $ownedProcessId = $running.Id; $ownedStartTicks = $running.StartTime.Ticks }
        if (Test-Path -LiteralPath $log) {
            $completed = Select-String -LiteralPath $log -Pattern 'CS2_NATIVE_STATUS complete$' -Quiet
            $failed = Select-String -LiteralPath $log -Pattern 'CS2_NATIVE_STATUS failed$' -Quiet
            if ($failed) { throw 'Native capture rejected; inspect private engine.log' }
            if ($completed -and -not $running) { $captureSucceeded = $true; break }
        }
        if ($null -ne $ownedProcessId -and -not $running) { throw 'The offline CS2 client exited before capture completed' }
        if ((Get-Date) -gt $deadline) { throw 'Native render timed out' }
    } while ($true)
} finally {
    # Only the exact process started for this capture may be stopped. A user
    # opening a later CS2 session is never selected by its executable name.
    try {
        if (-not $captureSucceeded) {
            # Discover the owned child before disposing/killing its launcher.
            $owned = Get-CaptureCs2Process
            if ($owned -and $null -eq $ownedProcessId) { $ownedProcessId = $owned.Id; $ownedStartTicks = $owned.StartTime.Ticks }
            if ($hlaeProcess -and -not $hlaeProcess.HasExited) {
                $hlaeProcess.Kill()
                if (-not $hlaeProcess.WaitForExit(10000)) { throw 'HLAE did not exit; settings backup retained' }
            }
            # A failed launcher may already have created CS2 before returning error.
            $owned = Get-CaptureCs2Process
            if ($owned) {
                $owned | Stop-Process -Force
                if (-not $owned.WaitForExit(30000)) { throw 'The capture-owned CS2 did not exit; settings backup retained' }
            }
        }
        if ($settings -and -not $launchAttempted) {
            # No engine was launched. Preserve any external setting edits that
            # caused preflight to abort; only undo our own attribute protection.
            if (-not (Undo-CaptureSettingsProtection $settings)) { throw 'CS2 preflight protection could not be fully removed; backup retained for review' }
            Complete-CaptureSettings $settings 'not_started'
        } elseif ($settings) {
            $assertSafeRestore = {
                if (Get-CaptureCs2Process) { throw 'Capture-owned CS2 is still running; settings backup retained' }
                if (Get-Process cs2 -ErrorAction SilentlyContinue) { throw 'Another CS2 session is running; original settings backup retained without changing it' }
                Assert-CaptureSteamUser $settingsContext
            }
            # Let Steam finish its exit-time local/cloud-shadow writes. Never
            # alter cloud toggles, remotecache or another user's configuration.
            for ($settle = 0; $settle -lt 15; $settle++) { & $assertSafeRestore; Start-Sleep -Milliseconds 200 }
            for ($attempt = 0; $attempt -lt 3; $attempt++) {
                try { Restore-CaptureSettings $settings $assertSafeRestore }
                catch {
                    & $assertSafeRestore
                    if ($attempt -eq 2) { throw }
                    Start-Sleep -Seconds 1
                    continue
                }
                for ($settle = 0; $settle -lt 10; $settle++) { & $assertSafeRestore; Start-Sleep -Milliseconds 200 }
                $stable = @((Get-CaptureSettingFiles $settingsContext.cfg) | Where-Object {
                    $name = $_.Name; $entry = @($settings.entries | Where-Object { $_.name -eq $name })
                    $entry.Count -ne 1 -or (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash -ne $entry[0].sha256
                }).Count -eq 0 -and @(Get-CaptureSettingFiles $settingsContext.cfg).Count -eq $settings.entries.Count
                if ($stable) { Complete-CaptureSettings $settings; break }
            }
            if ($settings.status -ne 'restored') { throw 'CS2 settings did not remain restored; backup retained for review' }
            Write-Output 'Original CS2 settings restored and byte-verified.'
        }
    } finally {
        try {
            if ($settings) {
                if ($settings.status -eq 'pending') { $null = Undo-CaptureSettingsProtection $settings }
                # Original private bytes survive media upload/work cleanup.
                [IO.File]::WriteAllText((Join-Path $OutputDirectory 'settings-state.json'), (@{ version = 1; status = $settings.status; backup_directory = $settings.backup_directory } | ConvertTo-Json -Compress))
            }
        } finally {
            if ($hlaeProcess) { $hlaeProcess.Dispose() }
            if ($settingsLockHeld) { $settingsLock.ReleaseMutex() }
            if ($settingsLock) { $settingsLock.Dispose() }
        }
    }
}
$evidence = Join-Path $OutputDirectory 'frame-evidence.jsonl'
& (Join-Path $PSScriptRoot 'parse-evidence.ps1') -LogPath $log -OutputPath $evidence
# The private artifact is intentionally not published or labeled validated here.
Write-Output "Native capture finished. Validate media and frame evidence before ingestion: $OutputDirectory"
