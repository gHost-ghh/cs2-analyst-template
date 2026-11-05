# Dot-sourced by the capture runner. All snapshots stay beside its private output.
# Never read or write Steam sharedconfig, remotecache, login state or other users.
function Test-CaptureSettingName([string]$Name) {
    return $Name -imatch '^(?:cs2_video\.txt|cs2_machine_convars\.vcfg|cs2_user_(?:convars|keys)_[0-9]{1,2}_slot[0-3]\.vcfg)(?:_lastclouded)?$'
}

function Assert-CapturePlainPath([string]$Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Capture settings path contains a reparse point' }
        }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ($parent -eq $current) { break }
        $current = $parent
    }
}

function Get-CaptureSettingsContext([string]$Executable) {
    $steam = (Get-ItemProperty -LiteralPath 'HKCU:\Software\Valve\Steam' -ErrorAction Stop).SteamPath
    $active = (Get-ItemProperty -LiteralPath 'HKCU:\Software\Valve\Steam\ActiveProcess' -ErrorAction Stop).ActiveUser
    if (-not $steam -or -not $active -or [string]$active -notmatch '^[0-9]{1,10}$') { throw 'An active Steam user is required to protect CS2 settings' }
    $steam = (Resolve-Path -LiteralPath $steam -ErrorAction Stop).Path
    Assert-CapturePlainPath $steam
    # Match the selected executable to a registered Steam 730 installation.
    $libraries = @($steam)
    $libraryFile = Join-Path $steam 'steamapps/libraryfolders.vdf'
    if (Test-Path -LiteralPath $libraryFile -PathType Leaf) {
        foreach ($match in [regex]::Matches([IO.File]::ReadAllText($libraryFile), '"path"\s+"([^"\r\n]+)"')) { $libraries += $match.Groups[1].Value.Replace('\\', '\') }
    }
    $registered = $false
    foreach ($library in ($libraries | Select-Object -Unique)) {
        $manifest = Join-Path $library 'steamapps/appmanifest_730.acf'
        if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { continue }
        $directory = [regex]::Match([IO.File]::ReadAllText($manifest), '"installdir"\s+"([^"\r\n]+)"').Groups[1].Value
        if (-not $directory -or $directory.Contains('..') -or $directory.IndexOfAny([char[]]'\/') -ge 0) { continue }
        $candidate = [IO.Path]::GetFullPath((Join-Path $library ('steamapps/common/' + $directory + '/game/bin/win64/cs2.exe')))
        if ($candidate -eq $Executable) { $registered = $true; break }
    }
    if (-not $registered) { throw 'CS2 executable does not match the registered Steam installation' }
    $cfg = [IO.Path]::GetFullPath((Join-Path $steam ('userdata/' + [string]$active + '/730/local/cfg')))
    Assert-CapturePlainPath $cfg
    return @{ steam = $steam; active_user = [string]$active; cfg = $cfg }
}

function Assert-CaptureSteamUser($Context) {
    $steam = (Get-ItemProperty -LiteralPath 'HKCU:\Software\Valve\Steam' -ErrorAction Stop).SteamPath
    $active = (Get-ItemProperty -LiteralPath 'HKCU:\Software\Valve\Steam\ActiveProcess' -ErrorAction Stop).ActiveUser
    if (-not $steam -or (Resolve-Path -LiteralPath $steam).Path -ne $Context.steam -or [string]$active -ne $Context.active_user) { throw 'Steam user changed; settings backup retained without overwriting another session' }
}

function Get-CaptureSettingFiles([string]$Directory) {
    Assert-CapturePlainPath $Directory
    if (-not (Test-Path -LiteralPath $Directory)) { return @() }
    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { throw 'CS2 settings directory is not a directory' }
    $files = @(Get-ChildItem -LiteralPath $Directory -Force | Where-Object { Test-CaptureSettingName $_.Name })
    if ($files.Count -gt 256) { throw 'Too many CS2 settings files to protect safely' }
    $totalBytes = 0
    foreach ($file in $files) {
        if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $file.Length -gt 2MB) { throw 'Unsafe or oversized CS2 settings file' }
        $totalBytes += $file.Length
    }
    if ($totalBytes -gt 8MB) { throw 'CS2 settings snapshot exceeds its total size limit' }
    return $files
}

function Protect-CaptureSettings($State, [scriptblock]$AssertSafe) {
    $State.protected_names = @()
    & $AssertSafe
    $current = @(Get-CaptureSettingFiles $State.context.cfg)
    if ($current.Count -ne $State.entries.Count) { throw 'CS2 settings changed before launch; capture was not started' }
    foreach ($entry in $State.entries) {
        $target = Join-Path $State.context.cfg $entry.name
        Assert-CapturePlainPath $target
        if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $entry.sha256) { throw 'CS2 settings changed before launch; capture was not started' }
    }
    foreach ($entry in $State.entries) {
        & $AssertSafe
        $target = Join-Path $State.context.cfg $entry.name
        Assert-CapturePlainPath $target
        # Prevent ordinary engine/Steam exit-time writes during capture. This is
        # restored to the exact original attributes in finally, including files
        # that were already read-only. No Steam cloud/account setting is changed.
        [IO.File]::SetAttributes($target, ([IO.FileAttributes][int]$entry.attributes -bor [IO.FileAttributes]::ReadOnly))
        $State.protected_names += $entry.name
    }
}

function Undo-CaptureSettingsProtection($State) {
    $safe = $true
    foreach ($name in $State.protected_names) {
        $entry = @($State.entries | Where-Object { $_.name -eq $name })[0]
        if ([IO.FileAttributes][int]$entry.attributes -band [IO.FileAttributes]::ReadOnly) { continue }
        $target = Join-Path $State.context.cfg $entry.name
        Assert-CapturePlainPath $target
        if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { continue }
        $attributes = [IO.File]::GetAttributes($target)
        if (-not ($attributes -band [IO.FileAttributes]::ReadOnly)) { continue }
        $protectedAttributes = [IO.FileAttributes][int]$entry.attributes -bor [IO.FileAttributes]::ReadOnly
        if ($attributes -eq $protectedAttributes -and (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -eq $entry.sha256) { [IO.File]::SetAttributes($target, [IO.FileAttributes][int]$entry.attributes) }
        else { $safe = $false }
    }
    return $safe
}

function Save-CaptureSettings($Context, [string]$BackupDirectory, [string]$MarkerFile = '') {
    Assert-CapturePlainPath $BackupDirectory
    if ($MarkerFile) {
        Assert-CapturePlainPath $MarkerFile
        if (Test-Path -LiteralPath $MarkerFile) { throw 'An earlier CS2 settings transaction is pending; review its private backup before another capture' }
    }
    if (Test-Path -LiteralPath $BackupDirectory) { throw 'Capture settings backup must be new; pending backups require manual review' }
    New-Item -ItemType Directory -Path $BackupDirectory | Out-Null
    # Configuration can contain private key bindings. Limit backup access to the
    # current Windows user and SYSTEM rather than relying on checkout ACLs.
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))) {
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    }
    Set-Acl -LiteralPath $BackupDirectory -AclObject $acl
    $entries = @()
    foreach ($file in @(Get-CaptureSettingFiles $Context.cfg)) {
        $bytes = [IO.File]::ReadAllBytes($file.FullName)
        $copy = Join-Path $BackupDirectory $file.Name
        [IO.File]::WriteAllBytes($copy, $bytes)
        $entries += @{ name = $file.Name; sha256 = (Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash; length = $bytes.Length; last_write_utc = $file.LastWriteTimeUtc.Ticks; attributes = [int]$file.Attributes }
    }
    $state = @{ version = 1; context = $Context; backup_directory = $BackupDirectory; entries = $entries; status = 'pending' }
    [IO.File]::WriteAllText((Join-Path $BackupDirectory 'state.json'), ($state | ConvertTo-Json -Depth 8))
    if ($MarkerFile) {
        $state.marker_file = $MarkerFile
        $state.marker_text = (@{ version = 1; backup_directory = $BackupDirectory } | ConvertTo-Json -Compress)
        $marker = New-Object IO.FileStream($MarkerFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $markerBytes = [Text.Encoding]::UTF8.GetBytes($state.marker_text); $marker.Write($markerBytes, 0, $markerBytes.Length); $marker.Flush($true) } finally { $marker.Dispose() }
    }
    return $state
}

function Restore-CaptureSettings($State, [scriptblock]$AssertSafe) {
    # Never automatically recover an old manifest: the caller holds the current
    # in-memory transaction and proves its own process has completely exited.
    if ($State.status -ne 'pending') { throw 'Invalid settings restore transaction' }
    & $AssertSafe
    $existing = @(Get-CaptureSettingFiles $State.context.cfg)
    $original = @{}
    foreach ($entry in $State.entries) {
        if (-not (Test-CaptureSettingName $entry.name) -or $original.ContainsKey($entry.name)) { throw 'Invalid settings backup filename' }
        $copy = Join-Path $State.backup_directory $entry.name
        Assert-CapturePlainPath $copy
        if ((Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash -ne $entry.sha256) { throw 'Settings backup integrity check failed' }
        $original[$entry.name] = $entry
    }
    foreach ($entry in $State.entries) {
        & $AssertSafe
        $target = Join-Path $State.context.cfg $entry.name
        Assert-CapturePlainPath $target
        $currentHash = if (Test-Path -LiteralPath $target -PathType Leaf) { (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash } else { '' }
        # Windows also denies timestamp updates on a read-only file whose bytes
        # did not change; remove protection before metadata restoration as well.
        if (Test-Path -LiteralPath $target) { [IO.File]::SetAttributes($target, [IO.FileAttributes]::Normal) }
        if ($currentHash -ne $entry.sha256) {
            $temporary = Join-Path $State.context.cfg ('.cs2lab-restore-' + [Guid]::NewGuid().ToString('N') + '.tmp')
            try {
                $stream = New-Object IO.FileStream($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
                try { $bytes = [IO.File]::ReadAllBytes((Join-Path $State.backup_directory $entry.name)); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
                & $AssertSafe
                Assert-CapturePlainPath $target
                if (Test-Path -LiteralPath $target) { [IO.File]::Replace($temporary, $target, [NullString]::Value) } else { [IO.File]::Move($temporary, $target) }
            } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
        }
        [IO.File]::SetLastWriteTimeUtc($target, (New-Object DateTime([long]$entry.last_write_utc, [DateTimeKind]::Utc)))
        [IO.File]::SetAttributes($target, [IO.FileAttributes][int]$entry.attributes)
    }
    foreach ($file in $existing) {
        if (-not $original.ContainsKey($file.Name)) {
            & $AssertSafe
            Assert-CapturePlainPath $file.FullName
            # Only known engine-generated names absent in this transaction are
            # removed. Unknown files and Steam global/cloud metadata are untouched.
            Remove-Item -LiteralPath $file.FullName -Force
        }
    }
    & $AssertSafe
    $after = @(Get-CaptureSettingFiles $State.context.cfg)
    if ($after.Count -ne $State.entries.Count) { throw 'CS2 settings file set changed during restoration' }
    foreach ($entry in $State.entries) {
        if ((Get-FileHash -LiteralPath (Join-Path $State.context.cfg $entry.name) -Algorithm SHA256).Hash -ne $entry.sha256) { throw 'CS2 settings byte verification failed' }
    }
}

function Complete-CaptureSettings($State, [string]$Status = 'restored') {
    if ($Status -notin @('restored', 'not_started')) { throw 'Invalid completed settings transaction state' }
    $State.status = $Status
    [IO.File]::WriteAllText((Join-Path $State.backup_directory 'state.json'), ($State | ConvertTo-Json -Depth 8))
    if ($State.marker_file) {
        Assert-CapturePlainPath $State.marker_file
        if ([IO.File]::ReadAllText($State.marker_file) -ne $State.marker_text) { throw 'Settings transaction marker changed; retained for review' }
        Remove-Item -LiteralPath $State.marker_file
    }
}
