import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';

test('download archive includes settings protection and every shipped source matches its manifest', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cs2-download-package-'));
  const zipPath = path.join(root, 'cs2lab-windows.zip');
  try {
    const packaged = spawnSync(process.execPath, [fileURLToPath(new URL('./package.mjs', import.meta.url)), '--output', zipPath], { encoding: 'utf8', windowsHide: true });
    assert.equal(packaged.status, 0, packaged.stderr);
    const zip = await fs.readFile(zipPath), entries = new Map();
    let offset = 0;
    while (zip.readUInt32LE(offset) === 0x04034b50) {
      assert.equal(zip.readUInt16LE(offset + 8), 8);
      const compressedSize = zip.readUInt32LE(offset + 18), nameLength = zip.readUInt16LE(offset + 26), extraLength = zip.readUInt16LE(offset + 28);
      const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
      const start = offset + 30 + nameLength + extraLength;
      assert.equal(entries.has(name), false);
      entries.set(name, inflateRawSync(zip.subarray(start, start + compressedSize)));
      offset = start + compressedSize;
    }
    const prefix = 'cs2lab-windows/';
    const manifest = JSON.parse(entries.get(prefix + 'package-manifest.json').toString('utf8'));
    assert.ok(entries.has(prefix + 'native-animation/settings-state.ps1'));
    const installer = entries.get(prefix + 'install.ps1').toString('utf8');
    const runner = entries.get(prefix + 'native-animation/run-capture.ps1').toString('utf8');
    assert.match(installer, /'settings-state\.ps1'/);
    assert.match(runner, /Join-Path \$PSScriptRoot 'settings-state\.ps1'/);
    assert.equal(Object.keys(manifest.files).length, entries.size - 1);
    for (const [name, sha] of Object.entries(manifest.files)) {
      const bytes = entries.get(prefix + name);
      assert.ok(bytes, name);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), sha, name);
      const source = name.startsWith('native-animation/') ? new URL('../' + name, import.meta.url) : new URL('./' + name, import.meta.url);
      assert.deepEqual(bytes, await fs.readFile(source), name);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
