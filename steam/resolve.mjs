import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { resolveBatch } from './resolver.mjs';

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--output') {
    process.stderr.write('Usage: node steam/resolve.mjs --input INPUT.json --output OUTPUT.json\n');
    process.exitCode = 2;
    return;
  }
  let temporary;
  try {
    const input = JSON.parse(await readFile(args[1], 'utf8'));
    const result = await resolveBatch(input);
    const output = resolve(args[3]);
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    temporary = `${output}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, output);
    const counts = result.reduce((value, row) => ({ ...value, [row.status]: (value[row.status] ?? 0) + 1 }), {});
    process.stderr.write(`Steam resolver completed: ${JSON.stringify(counts)}\n`);
  } catch {
    process.stderr.write('Steam resolver failed: INPUT_OR_OUTPUT_ERROR\n');
    process.exitCode = 2;
  } finally {
    if (temporary) await rm(temporary, { force: true }).catch(() => {});
  }
}

await main();
