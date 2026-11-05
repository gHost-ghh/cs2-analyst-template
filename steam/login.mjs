import { resolve } from 'node:path';
import { bootstrapQr } from './bootstrap.mjs';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--output') {
  process.stderr.write('Usage: node steam/login.mjs --output steam/refresh.token\n');
  process.exitCode = 2;
} else {
  const aborter = new AbortController();
  const cancel = () => aborter.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  process.stderr.write('Use the Steam mobile app to scan this QR code and approve your cloud login.\n');
  try {
    await bootstrapQr({ output: resolve(args[1]), signal: aborter.signal });
    process.stderr.write('Refresh token saved to the requested private file. It was not printed.\n');
  } catch {
    process.stderr.write('Steam QR login failed or output file already exists. Retry with a new output path.\n');
    process.exitCode = 2;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
