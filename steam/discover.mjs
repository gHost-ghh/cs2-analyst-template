import { writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { discoverRecentGames } from './resolver.mjs';

const args = process.argv.slice(2);
let temporary;
try {
  if (args.length !== 2 || args[0] !== '--output') throw new Error('INVALID_ARGUMENTS');
  const result = await discoverRecentGames();
  const output = resolve(args[1]);
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  temporary = `${output}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(result), { mode: 0o600, flag: 'wx' });
  await rename(temporary, output);
  process.stderr.write(`GC recent discovery: ${result.status}, ${result.matches.length} codes\n`);
} catch {
  process.stderr.write('GC recent discovery failed: INPUT_OR_OUTPUT_ERROR\n');
  process.exitCode = 2;
} finally {
  if (temporary) await rm(temporary, { force: true }).catch(() => {});
}
