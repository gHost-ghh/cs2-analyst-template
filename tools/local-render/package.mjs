import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const output = process.argv[2] === '--output' ? process.argv[3] : null;
if (!output || process.argv.length !== 4) throw new Error('Usage: node tools/local-render/package.mjs --output /absolute/path/cs2lab-windows.zip');
const names = ['install.cmd', 'install.ps1', 'runtime-lock.json', 'protocol.mjs', 'companion.mjs', 'capture-runtime.mjs', 'cache.mjs', 'bridge.html', 'bridge.js', 'bridge.css', 'discover-steam.ps1', 'choose-demo.ps1', 'README.md', 'LOCAL_CODEX_HANDOFF.md'];
const files = [];
for (const name of names) files.push({ name, bytes: await fs.readFile(path.join(here, name)) });
for (const name of ['capture.js', 'run-capture.ps1', 'parse-evidence.ps1', 'settings-state.ps1']) files.push({ name: `native-animation/${name}`, bytes: await fs.readFile(path.join(here, '../native-animation', name)) });
files.push({ name: 'package-manifest.json', bytes: Buffer.from(JSON.stringify({ version: '1.0', files: Object.fromEntries(files.map(file => [file.name, createHash('sha256').update(file.bytes).digest('hex')])) }, null, 2) + '\n') });

const crc32 = bytes => {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
};
const local = [], central = [];
let offset = 0;
for (const file of files) {
  const name = Buffer.from(`cs2lab-windows/${file.name}`), compressed = deflateRawSync(file.bytes), crc = crc32(file.bytes);
  const header = Buffer.alloc(30), directory = Buffer.alloc(46);
  header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(0x5d53, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(file.bytes.length, 22); header.writeUInt16LE(name.length, 26);
  directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(8, 10); directory.writeUInt16LE(0x5d53, 14); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(file.bytes.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
  local.push(header, name, compressed); central.push(directory, name); offset += header.length + name.length + compressed.length;
}
const directory = Buffer.concat(central), end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...local, directory, end]);
await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
await fs.writeFile(output, zip);
console.log(JSON.stringify({ output: path.resolve(output), files: files.length, bytes: zip.length, sha256: createHash('sha256').update(zip).digest('hex') }));
