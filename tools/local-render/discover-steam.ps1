$ErrorActionPreference = 'Stop'
$steam = (Get-ItemProperty -LiteralPath 'HKCU:\Software\Valve\Steam' -ErrorAction SilentlyContinue).SteamPath
if (-not $steam) { $steam = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam' -ErrorAction SilentlyContinue).InstallPath }
if (-not $steam -or -not (Test-Path -LiteralPath $steam -PathType Container)) { throw 'Steam installation was not found' }
$libraries = @($steam)
$libraryFile = Join-Path $steam 'steamapps/libraryfolders.vdf'
if (Test-Path -LiteralPath $libraryFile) {
    $vdf = [IO.File]::ReadAllText($libraryFile)
    foreach ($match in [regex]::Matches($vdf, '"path"\s+"([^"\r\n]+)"')) { $libraries += $match.Groups[1].Value.Replace('\\', '\') }
}
$found = $null
foreach ($library in ($libraries | Select-Object -Unique)) {
    $manifest = Join-Path $library 'steamapps/appmanifest_730.acf'
    if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { continue }
    $acf = [IO.File]::ReadAllText($manifest)
    $directory = [regex]::Match($acf, '"installdir"\s+"([^"\r\n]+)"').Groups[1].Value
    if (-not $directory -or $directory.Contains('..') -or $directory.IndexOfAny([char[]]'\/') -ge 0) { continue }
    $executable = Join-Path $library ('steamapps/common/' + $directory + '/game/bin/win64/cs2.exe')
    if (Test-Path -LiteralPath $executable -PathType Leaf) {
        $build = [regex]::Match($acf, '"buildid"\s+"([0-9]+)"').Groups[1].Value
        $found = @{ cs2 = $executable; steam = (Join-Path $steam 'Steam.exe'); game_build = ('steam-app-730:' + $build); cs2_running = [bool](Get-Process cs2 -ErrorAction SilentlyContinue) }
        break
    }
}
if (-not $found) { throw 'CS2 installation was not found in Steam libraries' }
$found | ConvertTo-Json -Compress
