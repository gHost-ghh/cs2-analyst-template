import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, stat, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapQr } from '../bootstrap.mjs';

async function withDirectory(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'cs2-steam-test-'));
  try { await fn(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('QR bootstrap writes token to a private file, renders only the challenge, closes session', () => withDirectory(async (directory) => {
  const session = new EventEmitter();
  let closed = false;
  let qr;
  session.refreshToken = 'private-refresh-token';
  session.startWithQR = async () => {
    setImmediate(() => session.emit('authenticated'));
    return { qrChallengeUrl: 'https://s.team/q/test-challenge' };
  };
  session.cancelLoginAttempt = () => { closed = true; };
  const output = join(directory, 'refresh.token');
  await bootstrapQr({ output, sessionFactory: () => session, renderQr: (value) => { qr = value; } });
  assert.equal(await readFile(output, 'utf8'), 'private-refresh-token\n');
  // POSIX mode bits are not NTFS ACLs. Windows users must use a private folder;
  // this test still verifies exact token contents and exclusive creation there.
  if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.equal(qr, 'https://s.team/q/test-challenge');
  assert.equal(closed, true);
}));

test('QR bootstrap refuses existing files without creating a Steam session', () => withDirectory(async (directory) => {
  const real = join(directory, 'existing.token');
  await writeFile(real, 'keep-existing-value');
  await assert.rejects(bootstrapQr({ output: real, sessionFactory: () => assert.fail('must not create session') }));
  assert.equal(await readFile(real, 'utf8'), 'keep-existing-value');
}));

test('QR bootstrap refuses a pre-existing symlink without changing its target', t => withDirectory(async directory => {
  const real = join(directory, 'existing.token'), link = join(directory, 'link.token');
  await writeFile(real, 'keep-existing-value');
  try { await symlink(real, link); } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) { t.skip('Windows symlink privilege unavailable'); return; }
    throw error;
  }
  await assert.rejects(bootstrapQr({ output: link, sessionFactory: () => assert.fail('must not create session') }));
  assert.equal(await readFile(real, 'utf8'), 'keep-existing-value');
}));

test('QR bootstrap timeout cleans up token file and upstream messages', () => withDirectory(async (directory) => {
  const session = new EventEmitter();
  let closed = false;
  session.startWithQR = async () => ({ qrChallengeUrl: 'https://s.team/q/test' });
  session.cancelLoginAttempt = () => { closed = true; };
  const output = join(directory, 'timeout.token');
  await assert.rejects(bootstrapQr({ output, timeoutMs: 20, sessionFactory: () => session, renderQr: () => {} }), /LOGIN_TIMEOUT/);
  await assert.rejects(stat(output), { code: 'ENOENT' });
  assert.equal(closed, true);
}));
