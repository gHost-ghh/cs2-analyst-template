import { open, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { LoginSession, EAuthTokenPlatformType } from 'steam-session';
import qrcode from 'qrcode-terminal';

/** Interactive one-time bootstrap. The refresh token never reaches stdout. */
export async function bootstrapQr({
  output,
  timeoutMs = 180_000,
  sessionFactory = () => new LoginSession(EAuthTokenPlatformType.SteamClient),
  renderQr = (url) => qrcode.generate(url, { small: true }),
  signal,
}) {
  if (!output) throw new Error('OUTPUT_PATH_REQUIRED');
  // Reserve the private file before asking the user to approve a login. Never
  // overwrite an existing credential or follow a pre-existing symbolic link.
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const file = await open(output, 'wx', 0o600);
  let successful = false;
  let session;
  try {
    session = sessionFactory();
    session.loginTimeout = timeoutMs;
    const token = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', aborted);
        if (error) reject(error);
        else resolve(value);
      };
      const aborted = () => finish(new Error('LOGIN_CANCELLED'));
      const timer = setTimeout(() => finish(new Error('LOGIN_TIMEOUT')), timeoutMs);
      // Deliberately never forward upstream errors or debug events.
      session.on('error', () => finish(new Error('STEAM_LOGIN_FAILED')));
      session.once('timeout', () => finish(new Error('LOGIN_TIMEOUT')));
      session.once('authenticated', () => {
        if (!session.refreshToken) finish(new Error('REFRESH_TOKEN_NOT_ISSUED'));
        else finish(null, session.refreshToken);
      });
      if (signal?.aborted) {
        aborted();
        return;
      }
      signal?.addEventListener('abort', aborted, { once: true });
      Promise.resolve().then(() => session.startWithQR()).then((result) => {
        if (!settled) renderQr(result.qrChallengeUrl);
      }).catch(() => finish(new Error('STEAM_LOGIN_FAILED')));
    });
    await file.writeFile(`${token}\n`, 'utf8');
    await file.sync();
    successful = true;
  } finally {
    try { session?.cancelLoginAttempt(); } catch { /* Best-effort transport cleanup. */ }
    await file.close();
    if (!successful) await rm(output, { force: true });
  }
}
