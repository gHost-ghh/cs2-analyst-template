param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'CS2DemoLab'
$protocolKey = 'HKCU:\Software\Classes\cs2lab'
if ($Uninstall) {
    if (Test-Path -LiteralPath $protocolKey) { Remove-Item -LiteralPath $protocolKey -Recurse -Force }
    Write-Host 'CS2 Demo Lab URI registration removed. Local captures are retained in your LocalAppData/CS2DemoLab folder.'
    exit 0
}
if (-not [Environment]::Is64BitOperatingSystem -or [Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'This package targets Windows 11 x64' }
$lock = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime-lock.json') -Raw | ConvertFrom-Json
$cache = Join-Path $root 'downloads'
New-Item -ItemType Directory -Force -Path $root, $cache, (Join-Path $root 'app'), (Join-Path $root 'native-animation') | Out-Null
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
function Get-PinnedFile($entry, $name) {
    $destination = Join-Path $cache $name
    if ((Test-Path -LiteralPath $destination) -and (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -eq $entry.sha256) { return $destination }
    Write-Host ('Downloading ' + $name + ' ...')
    Invoke-WebRequest -Uri $entry.url -OutFile ($destination + '.partial') -UseBasicParsing
    if ((Get-FileHash -LiteralPath ($destination + '.partial') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256) {
        Remove-Item -LiteralPath ($destination + '.partial') -Force
        throw ('Download integrity check failed: ' + $name)
    }
    Move-Item -LiteralPath ($destination + '.partial') -Destination $destination -Force
    return $destination
}
$nodeZip = Get-PinnedFile $lock.node 'node.zip'
$hlaeZip = Get-PinnedFile $lock.hlae 'hlae.zip'
$sevenzr = Get-PinnedFile $lock.sevenzr '7zr.exe'
$sevenExtra = Get-PinnedFile $lock.sevenzip '7zip.7z'
$ffmpegArchive = Get-PinnedFile $lock.ffmpeg 'ffmpeg.7z'
Expand-Archive -LiteralPath $nodeZip -DestinationPath (Join-Path $root 'node') -Force
Expand-Archive -LiteralPath $hlaeZip -DestinationPath (Join-Path $root 'hlae') -Force
& $sevenzr x '-y' ('-o' + (Join-Path $root '7zip')) $sevenExtra | Out-Null
if ($LASTEXITCODE -ne 0) { throw '7-Zip extraction failed' }
& $sevenzr x '-y' ('-o' + (Join-Path $root 'ffmpeg')) $ffmpegArchive | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'FFmpeg extraction failed' }
$nodeExe = Join-Path $root ('node/node-v' + $lock.node.version + '-win-x64/node.exe')
$ffmpegExe = @(Get-ChildItem -LiteralPath (Join-Path $root 'ffmpeg') -Filter ffmpeg.exe -Recurse | Select-Object -First 1)[0].FullName
$ffprobeExe = @(Get-ChildItem -LiteralPath (Join-Path $root 'ffmpeg') -Filter ffprobe.exe -Recurse | Select-Object -First 1)[0].FullName
if (-not $ffmpegExe -or -not $ffprobeExe -or -not (Test-Path -LiteralPath $nodeExe)) { throw 'Portable runtime preparation failed' }
# HLAE's built-in recording presets find this installed encoder automatically.
$hlaeEncoderDirectory = Join-Path $root 'hlae/ffmpeg/bin'
New-Item -ItemType Directory -Force -Path $hlaeEncoderDirectory | Out-Null
Copy-Item -LiteralPath $ffmpegExe -Destination (Join-Path $hlaeEncoderDirectory 'ffmpeg.exe') -Force
$appFiles = @('protocol.mjs', 'companion.mjs', 'capture-runtime.mjs', 'cache.mjs', 'bridge.html', 'bridge.js', 'bridge.css', 'discover-steam.ps1', 'choose-demo.ps1', 'runtime-lock.json')
foreach ($name in $appFiles) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $root ('app/' + $name)) -Force }
$native = Join-Path $PSScriptRoot 'native-animation'
if (-not (Test-Path -LiteralPath $native)) { $native = Join-Path $PSScriptRoot '../native-animation' }
foreach ($name in @('capture.js', 'run-capture.ps1', 'parse-evidence.ps1', 'settings-state.ps1')) { Copy-Item -LiteralPath (Join-Path $native $name) -Destination (Join-Path $root ('native-animation/' + $name)) -Force }
@{ version = '1.0'; hlae_version = $lock.hlae.version; hlae = (Join-Path $root 'hlae'); ffmpeg = $ffmpegExe; ffprobe = $ffprobeExe; sevenzip = (Join-Path $root '7zip/x64/7za.exe') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'runtime.json') -Encoding UTF8
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'app/discover-steam.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Steam/CS2 automatic detection failed; installation was not registered' }
New-Item -Path $protocolKey -Force | Out-Null
Set-Item -LiteralPath $protocolKey -Value 'URL:CS2 Demo Lab Local Render'
New-ItemProperty -LiteralPath $protocolKey -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
New-Item -Path ($protocolKey + '\shell\open\command') -Force | Out-Null
Set-Item -LiteralPath ($protocolKey + '\shell\open\command') -Value ('"' + $nodeExe + '" "' + (Join-Path $root 'app/companion.mjs') + '" "%1"')
Write-Host 'Installed. Open the dashboard and choose Render on this PC. Nothing runs at Windows startup.'
Write-Host 'CS2 must be closed before capture. The helper only opens offline Demo playback with -insecure.'
