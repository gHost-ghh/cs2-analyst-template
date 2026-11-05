param(
    [Parameter(Mandatory=$true)][string]$LogPath,
    [Parameter(Mandatory=$true)][string]$OutputPath
)
$ErrorActionPreference = 'Stop'

# Windows PowerShell's JSON converter accepts some non-JSON extensions. Validate
# the JSON grammar independently, without reserializing the original UTF-8 bytes.
# An explicit stack also bounds memory without recursive parser stack overflow.
if (-not ('Cs2NativeEvidenceJson' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
public static class Cs2NativeEvidenceJson {
    private static void Space(string s, ref int p) {
        while (p < s.Length && (s[p] == ' ' || s[p] == '\t' || s[p] == '\r' || s[p] == '\n')) p++;
    }
    private static bool Text(string s, ref int p) {
        if (p >= s.Length || s[p++] != '"') return false;
        while (p < s.Length) {
            char c = s[p++];
            if (c == '"') return true;
            if (c < 0x20) return false;
            if (c != '\\') continue;
            if (p == s.Length) return false;
            c = s[p++];
            if (c == '"' || c == '\\' || c == '/' || c == 'b' || c == 'f' || c == 'n' || c == 'r' || c == 't') continue;
            if (c != 'u' || p + 4 > s.Length) return false;
            for (int i = 0; i < 4; i++) {
                c = s[p++];
                if (!(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f') && !(c >= 'A' && c <= 'F')) return false;
            }
        }
        return false;
    }
    private static bool Value(string s, ref int p, List<int> stack) {
        Space(s, ref p);
        if (p == s.Length) return false;
        char c = s[p];
        // Object states: 0 = first key/end, 1 = comma/end, 2 = key after comma.
        // Array states: 3 = first value/end, 4 = comma/end, 5 = value after comma.
        if (c == '{' || c == '[') { p++; stack.Add(c == '{' ? 0 : 3); return true; }
        if (c == '"') return Text(s, ref p);
        foreach (string token in new string[] { "true", "false", "null" }) {
            if (p + token.Length <= s.Length && String.CompareOrdinal(s, p, token, 0, token.Length) == 0) { p += token.Length; return true; }
        }
        if (c == '-') { p++; if (p == s.Length) return false; }
        if (s[p] == '0') p++;
        else {
            if (s[p] < '1' || s[p] > '9') return false;
            while (p < s.Length && s[p] >= '0' && s[p] <= '9') p++;
        }
        if (p < s.Length && s[p] == '.') {
            p++; int first = p;
            while (p < s.Length && s[p] >= '0' && s[p] <= '9') p++;
            if (first == p) return false;
        }
        if (p < s.Length && (s[p] == 'e' || s[p] == 'E')) {
            p++;
            if (p < s.Length && (s[p] == '+' || s[p] == '-')) p++;
            int first = p;
            while (p < s.Length && s[p] >= '0' && s[p] <= '9') p++;
            if (first == p) return false;
        }
        return true;
    }
    public static bool Valid(string s) {
        int p = 0;
        var stack = new List<int>();
        if (!Value(s, ref p, stack)) return false;
        while (stack.Count > 0) {
            Space(s, ref p);
            if (p == s.Length) return false;
            int last = stack.Count - 1, state = stack[last];
            char c = s[p];
            if (state == 0 || state == 2) {
                if (state == 0 && c == '}') { p++; stack.RemoveAt(last); continue; }
                if (!Text(s, ref p)) return false;
                Space(s, ref p);
                if (p == s.Length || s[p++] != ':') return false;
                stack[last] = 1;
                if (!Value(s, ref p, stack)) return false;
            } else if (state == 3 || state == 5) {
                if (state == 3 && c == ']') { p++; stack.RemoveAt(last); continue; }
                stack[last] = 4;
                if (!Value(s, ref p, stack)) return false;
            } else {
                if (c == (state == 1 ? '}' : ']')) { p++; stack.RemoveAt(last); continue; }
                if (c != ',') return false;
                p++; stack[last] = state == 1 ? 2 : 5;
            }
        }
        Space(s, ref p);
        return p == s.Length;
    }
}
'@ | Out-Null
}

$inputFile = [IO.Path]::GetFullPath($LogPath)
$outputFile = [IO.Path]::GetFullPath($OutputPath)
if (-not [IO.File]::Exists($inputFile)) { throw 'Native evidence log does not exist' }
if (Test-Path -LiteralPath $outputFile) { throw 'Native evidence output must not already exist' }
$outputDirectory = [IO.Path]::GetDirectoryName($outputFile)
if (-not [IO.Directory]::Exists($outputDirectory)) { throw 'Native evidence output directory does not exist' }
$temporaryFile = Join-Path $outputDirectory ('.native-evidence-' + [Guid]::NewGuid().ToString('N') + '.tmp')
$reader = $null
$writer = $null
$published = $false
$expectedSequence = 0L
$expectedPart = 0
$expectedCount = 0
$totalBytes = 0L
$record = New-Object Text.StringBuilder
$utf8 = New-Object Text.UTF8Encoding($false, $true)
$tag = [regex]::new('\ACS2_NATIVE_PART ([0-9]+) ([0-9]+)/([0-9]+) ([A-Za-z0-9+/=]{1,128})\z', [Text.RegularExpressions.RegexOptions]::CultureInvariant)
try {
    $reader = [IO.StreamReader]::new($inputFile)
    $writer = [IO.File]::Open($temporaryFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    while ($null -ne ($line = $reader.ReadLine())) {
        $position = $line.IndexOf('CS2_NATIVE_PART', [StringComparison]::Ordinal)
        if ($position -lt 0) { continue }
        $match = $tag.Match($line.Substring($position))
        if (-not $match.Success) { throw 'Malformed native evidence transport tag' }
        $sequence = 0L; $part = 0L; $count = 0L
        if (-not [long]::TryParse($match.Groups[1].Value, [ref]$sequence) -or
            -not [long]::TryParse($match.Groups[2].Value, [ref]$part) -or
            -not [long]::TryParse($match.Groups[3].Value, [ref]$count)) { throw 'Native evidence transport number overflow' }
        if ($count -lt 1 -or $count -gt 256 -or $part -ge $count) { throw 'Invalid native evidence transport part bounds' }
        if ($sequence -ne $expectedSequence -or $part -ne $expectedPart) { throw 'Lost, duplicate or reordered native evidence transport part' }
        if ($expectedPart -eq 0) { $expectedCount = $count }
        if ($count -ne $expectedCount) { throw 'Native evidence transport part count changed within a record' }
        [void]$record.Append($match.Groups[4].Value)
        if ($record.Length -gt 32768) { throw 'Native evidence record exceeds 24576 decoded bytes' }
        $expectedPart++
        if ($expectedPart -lt $expectedCount) { continue }
        $encoded = $record.ToString()
        try { $bytes = [Convert]::FromBase64String($encoded) } catch { throw 'Invalid native evidence base64' }
        if ([Convert]::ToBase64String($bytes) -cne $encoded) { throw 'Noncanonical native evidence base64' }
        if ($bytes.Length -gt 24576) { throw 'Native evidence record exceeds 24576 decoded bytes' }
        try { $json = $utf8.GetString($bytes) } catch { throw 'Invalid native evidence UTF-8' }
        if ($json.IndexOfAny([char[]]"`r`n") -ge 0 -or -not [Cs2NativeEvidenceJson]::Valid($json)) { throw 'Invalid native evidence JSON record' }
        $totalBytes += $bytes.Length
        if ($totalBytes -gt 67108864) { throw 'Native evidence exceeds 64 MiB decoded bytes' }
        $expectedSequence++
        if ($expectedSequence -gt 100000) { throw 'Native evidence exceeds 100000 events' }
        $writer.Write($bytes, 0, $bytes.Length)
        $writer.WriteByte(10)
        [void]$record.Clear()
        $expectedPart = 0
        $expectedCount = 0
    }
    if ($expectedPart -ne 0) { throw 'Unterminated final native evidence record' }
    if ($expectedSequence -eq 0) { throw 'Native evidence log contains no records' }
    $writer.Dispose(); $writer = $null
    $reader.Dispose(); $reader = $null
    # File.Move is atomic within this directory and refuses an existing target,
    # including one created by another process after the initial existence check.
    [IO.File]::Move($temporaryFile, $outputFile)
    $published = $true
} finally {
    if ($writer) { $writer.Dispose() }
    if ($reader) { $reader.Dispose() }
    if (-not $published -and [IO.File]::Exists($temporaryFile)) { [IO.File]::Delete($temporaryFile) }
}
