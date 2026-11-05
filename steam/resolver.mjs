import SteamUser from 'steam-user';
import GlobalOffensive from 'globaloffensive';
import { decodeMatchShareCode, encodeMatch } from 'csgo-sharecode';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MatchListRequestFullGameInfo, MatchListRequestRecentUserGames } = require('globaloffensive/language.js');
const CODE_PATTERN = /^CSGO(?:-[ABCDEFGHJKLMNOPQRSTUVWXYZabcdefhijkmnopqrstuvwxyz23456789]{5}){5}$/;

export class ResolverError extends Error {
  constructor(errorCode, status = 'transient') {
    super(errorCode);
    this.errorCode = errorCode;
    this.status = status;
  }
}

export function normalizeEntries(input) {
  if (!Array.isArray(input)) throw new ResolverError('INPUT_MUST_BE_ARRAY', 'unavailable');
  if (input.length > 100) throw new ResolverError('INPUT_BATCH_LIMIT_100', 'unavailable');
  return input.map((entry) => {
    const value = typeof entry === 'string' ? { share_code: entry } : entry;
    if (!value || typeof value !== 'object' || typeof value.share_code !== 'string') {
      throw new ResolverError('INPUT_SHARE_CODE_REQUIRED', 'unavailable');
    }
    return {
      ...(typeof value.id === 'string' || typeof value.id === 'number' ? { id: value.id } : {}),
      share_code: value.share_code.trim(),
    };
  });
}

export function decodeRequest(shareCode) {
  if (!CODE_PATTERN.test(shareCode)) throw new ResolverError('INVALID_SHARE_CODE', 'unavailable');
  try {
    const { matchId, reservationId, tvPort } = decodeMatchShareCode(shareCode);
    if (matchId === 0n || reservationId === 0n) throw new Error('Zero match identifier');
    // Keep uint64 values as decimal strings: JS numbers would lose precision.
    return { matchId: matchId.toString(), outcomeId: reservationId.toString(), token: tvPort };
  } catch {
    throw new ResolverError('INVALID_SHARE_CODE', 'unavailable');
  }
}

export function replayUrlDiagnostic(value) {
  // Deliberately retain only the parsed host/scheme and a fixed reason code.
  // Never include raw values, paths, queries, fragments or URL credentials.
  const diagnostic = { host: null, scheme: null, reason: 'NOT_URL' };
  if (typeof value !== 'string' || !value) return diagnostic;
  if (value.length > 2048) return { ...diagnostic, reason: 'LENGTH_LIMIT' };
  try {
    const url = new URL(value);
    diagnostic.host = url.hostname || null;
    diagnostic.scheme = url.protocol;
    if (!['http:', 'https:'].includes(url.protocol)) diagnostic.reason = 'SCHEME_NOT_ALLOWED';
    else if (url.username || url.password) diagnostic.reason = 'CREDENTIALS_NOT_ALLOWED';
    else if (!/^replay[0-9]+\.(?:valve\.net|wmsj\.cn|csgo\.com\.cn)$/i.test(url.hostname)) diagnostic.reason = 'HOST_NOT_ALLOWED';
    else if (url.port) diagnostic.reason = 'PORT_NOT_ALLOWED';
    else if (!/^\/730\/[A-Za-z0-9_.-]+\.dem(?:\.bz2)?$/.test(url.pathname)) diagnostic.reason = 'PATH_NOT_ALLOWED';
    else if (url.search || url.hash) diagnostic.reason = 'QUERY_OR_FRAGMENT_NOT_ALLOWED';
    else diagnostic.reason = 'ACCEPTED';
    return diagnostic;
  } catch {
    return diagnostic;
  }
}

export function isValveReplayUrl(value) {
  return replayUrlDiagnostic(value).reason === 'ACCEPTED';
}

function replayCandidates(match) {
  // Valve's historical-game response uses the round-stats `map` string for
  // the replay URL. WatchableMatchInfo has live TV details, not a replay URL.
  const rounds = Array.isArray(match.roundstatsall) ? match.roundstatsall : [];
  return [...rounds.map((round) => round?.map), match.roundstats_legacy?.map]
    .filter((value) => value !== undefined && value !== null && value !== '');
}

export function replayUrlFromMatch(match) {
  return replayCandidates(match).find(isValveReplayUrl) ?? null;
}

export function replayUrlDiagnostics(match) {
  // Round arrays often repeat the same URL; keep diagnostics small and safe.
  const unique = new Map();
  for (const value of replayCandidates(match)) {
    const diagnostic = replayUrlDiagnostic(value);
    unique.set(JSON.stringify(diagnostic), diagnostic);
    if (unique.size >= 8) break;
  }
  return [...unique.values()];
}

export function matchTimeMetadata(match) {
  // cstrike15_gcmessages.proto declares matchtime as uint32 (Unix seconds).
  const seconds = match.matchtime;
  if (!Number.isInteger(seconds) || seconds <= 0 || seconds > 0xffffffff) {
    return { match_time_verified: false };
  }
  return {
    match_started_at: new Date(seconds * 1000).toISOString(),
    match_time_verified: true,
    timestamp_provenance: 'Steam GC matchList.matchtime',
  };
}

function uint64String(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  const text = String(value ?? '');
  if (!/^[1-9]\d{0,19}$/.test(text)) return null;
  const id = BigInt(text);
  return id <= 0xffffffffffffffffn ? text : null;
}

export function shareCodeFromRecentMatch(match) {
  const matchId = uint64String(match.matchid);
  // This is the terminal round's reservationid (the sharecode outcome id),
  // not WatchableMatchInfo.reservation_id, which describes a different field.
  const rounds = Array.isArray(match.roundstatsall) ? match.roundstatsall : [];
  const terminalRound = match.roundstats_legacy ?? rounds.at(-1);
  const outcomeId = uint64String(terminalRound?.reservationid);
  const tvPort = match.watchablematchinfo?.tv_port;
  if (!matchId || !outcomeId || !Number.isInteger(tvPort) || tvPort <= 0 || tvPort > 0xffffffff) {
    throw new ResolverError('GC_SHARE_CODE_FIELDS_MISSING', 'unavailable');
  }
  try {
    const code = encodeMatch({ matchId: BigInt(matchId), reservationId: BigInt(outcomeId), tvPort });
    const decoded = decodeRequest(code);
    // The token is the low 16 bits of the GC uint32 tv_port value.
    if (decoded.matchId !== matchId || decoded.outcomeId !== outcomeId || decoded.token !== (tvPort & 0xffff)) {
      throw new Error('Encoding did not round-trip');
    }
    return code;
  } catch {
    throw new ResolverError('GC_SHARE_CODE_ENCODING_FAILED', 'unavailable');
  }
}

export function recentMatchMetadata(match) {
  const matchId = uint64String(match.matchid);
  return {
    ...(matchId ? { match_id: matchId } : {}),
    ...matchTimeMetadata(match),
    discovery_source: 'steam_gc_recent',
    replay_url_diagnostics: replayUrlDiagnostics(match),
  };
}

export function validateRefreshToken(token, now = Date.now()) {
  if (!token?.trim()) throw new ResolverError('STEAM_REFRESH_TOKEN_MISSING', 'unavailable');
  let payload;
  try {
    payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    throw new ResolverError('STEAM_REFRESH_TOKEN_INVALID', 'unavailable');
  }
  if (!Array.isArray(payload.aud) || !payload.aud.includes('client')) {
    throw new ResolverError('STEAM_REFRESH_TOKEN_REQUIRES_CLIENT', 'unavailable');
  }
  // This is only a local expiry hint. Steam still verifies the token itself.
  if (typeof payload.exp === 'number' && payload.exp * 1000 <= now) {
    throw new ResolverError('STEAM_REFRESH_TOKEN_EXPIRED', 'expired');
  }
}

export function safeFailure(error) {
  if (error instanceof ResolverError) {
    return { status: error.status, error_code: error.errorCode, retryable: error.status === 'transient' };
  }
  if ([SteamUser.EResult.Expired, SteamUser.EResult.Revoked].includes(error?.eresult)) {
    return { status: 'expired', error_code: 'STEAM_REFRESH_TOKEN_REJECTED', retryable: false };
  }
  if ([SteamUser.EResult.InvalidPassword, SteamUser.EResult.AccessDenied,
    SteamUser.EResult.AccountDisabled, SteamUser.EResult.AccountLogonDenied].includes(error?.eresult)) {
    return { status: 'unavailable', error_code: 'STEAM_AUTH_REJECTED', retryable: false };
  }
  // Never propagate an upstream message: it can contain credentials or URLs.
  return { status: 'transient', error_code: 'STEAM_CONNECTION_FAILED', retryable: true };
}

function defaultClients() {
  const steam = new SteamUser({
    autoRelogin: false,
    dataDirectory: null,
    enablePicsCache: false,
    saveAppTickets: false,
    // Renewal invalidates the GitHub secret. Keep renewal a user-controlled step.
    renewRefreshTokens: false,
    webCompatibilityMode: true,
  });
  return { steam, gc: new GlobalOffensive(steam) };
}

function createSession({ steam, gc }, { connectionTimeoutMs, requestTimeoutMs, expectedSteamId64 }) {
  const aborter = new AbortController();
  let closed = false;
  const fail = (error) => {
    if (!closed && !aborter.signal.aborted) aborter.abort(error);
  };
  const disconnected = () => fail(new ResolverError('STEAM_DISCONNECTED'));
  const gcDisconnected = () => fail(new ResolverError('GC_DISCONNECTED'));
  const playingStateChanged = (blocked) => {
    if (blocked) fail(new ResolverError('STEAM_PLAYING_ELSEWHERE'));
  };
  const steamGuardRequired = () => fail(new ResolverError('STEAM_GUARD_REAUTH_REQUIRED', 'unavailable'));
  steam.on('error', fail);
  steam.on('disconnected', disconnected);
  steam.on('playingState', playingStateChanged);
  // Avoid steam-user's default stdin prompt in an unattended cron job.
  steam.on('steamGuard', steamGuardRequired);
  gc.on('error', fail);
  gc.on('disconnectedFromGC', gcDisconnected);

  function wait(emitter, event, accept, trigger, timeoutMs, timeoutCode) {
    if (aborter.signal.aborted) return Promise.reject(aborter.signal.reason);
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        emitter.removeListener(event, received);
        aborter.signal.removeEventListener('abort', aborted);
      };
      const done = (error, value) => {
        cleanup();
        if (error) reject(error);
        else resolve(value);
      };
      const received = (...args) => {
        try {
          const accepted = accept(...args);
          if (accepted !== undefined) done(null, accepted);
        } catch (error) { done(error); }
      };
      const aborted = () => done(aborter.signal.reason);
      emitter.on(event, received);
      aborter.signal.addEventListener('abort', aborted, { once: true });
      timer = setTimeout(() => done(new ResolverError(timeoutCode)), timeoutMs);
      try { trigger(); } catch (error) { done(error); }
    });
  }

  return {
    async connect(refreshToken) {
      await wait(steam, 'loggedOn', () => true,
        () => steam.logOn({ refreshToken }), connectionTimeoutMs, 'STEAM_LOGON_TIMEOUT');
      // A JWT's sub claim is not proof of the account which authenticated.
      // Check the server-authenticated SteamUser identity before entering CS2.
      if (steam.steamID?.getSteamID64?.() !== expectedSteamId64) {
        throw new ResolverError('STEAM_ACCOUNT_MISMATCH', 'unavailable');
      }
      if (steam.playingState?.blocked) throw new ResolverError('STEAM_PLAYING_ELSEWHERE');
      await wait(gc, 'connectedToGC', () => true,
        () => steam.gamesPlayed([730], false), connectionTimeoutMs, 'GC_CONNECTION_TIMEOUT');
    },
    async resolve(request) {
      return wait(gc, 'matchList', (matches, data) => {
        if (!Array.isArray(matches)) return undefined;
        const match = matches.find((value) => String(value.matchid) === request.matchId);
        if (match) {
          const url = replayUrlFromMatch(match);
          const metadata = { match_id: request.matchId, ...matchTimeMetadata(match), replay_url_diagnostics: replayUrlDiagnostics(match) };
          return url
            ? { status: 'resolved', url, ...metadata, retryable: false }
            : { status: 'unavailable', error_code: metadata.replay_url_diagnostics.some(d=>d.reason==='HOST_NOT_ALLOWED')
              ? 'REPLAY_HOST_NOT_ALLOWED' : 'REPLAY_URL_UNAVAILABLE', ...metadata, retryable: false };
        }
        if (!matches.length && data?.msgrequestid === MatchListRequestFullGameInfo) {
          return { status: 'unavailable', error_code: 'MATCH_UNAVAILABLE', retryable: false };
        }
        return undefined; // Unsolicited GC events must not resolve another match.
      }, () => gc.requestGame(request), requestTimeoutMs, 'GC_MATCH_TIMEOUT');
    },
    async recentGames() {
      const accountId = Number(BigInt(expectedSteamId64) - 76561197960265728n);
      return wait(gc, 'matchList', (matches, data) => {
        if (!Array.isArray(matches) || data?.msgrequestid !== MatchListRequestRecentUserGames) return undefined;
        // Recent-user responses can be unsolicited; both request kind and
        // target account must identify this request before accepting the list.
        if (data.accountid !== accountId) return undefined;
        return matches;
      }, () => {
        if (gc.requestRecentGames(expectedSteamId64) === false) {
          throw new ResolverError('GC_RECENT_REQUEST_REJECTED', 'unavailable');
        }
      }, requestTimeoutMs, 'GC_RECENT_MATCHES_TIMEOUT');
    },
    async close() {
      closed = true;
      try { steam.gamesPlayed([]); } catch { /* Login can fail before gamesPlayed is available. */ }
      // globaloffensive 3.3.0 clears _helloInterval on disconnect but schedules
      // _helloTimer. Clear the pinned version's timer to keep short cron jobs bounded.
      clearTimeout(gc._helloTimer);
      gc._helloTimer = null;
      try { steam.logOff(); } catch { /* Teardown must not replace the result. */ }
      steam.removeListener('disconnected', disconnected);
      steam.removeListener('playingState', playingStateChanged);
      steam.removeListener('steamGuard', steamGuardRequired);
      gc.removeListener('disconnectedFromGC', gcDisconnected);
      // Keep error handlers attached through the asynchronous network shutdown.
    },
  };
}

export async function discoverRecentGames({
  refreshToken = process.env.STEAM_REFRESH_TOKEN,
  expectedSteamId64 = process.env.STEAMID64,
  connectionTimeoutMs = 45_000,
  requestTimeoutMs = 30_000,
  clientsFactory = defaultClients,
} = {}) {
  if (typeof refreshToken === 'string') refreshToken = refreshToken.trim();
  if (typeof expectedSteamId64 === 'string') expectedSteamId64 = expectedSteamId64.trim();
  const result = {
    status: 'discovered', matches: [], unencodable_matches: [],
    reported_count: 0, documented_max_matches: 8, retryable: false,
  };
  let session;
  try {
    validateRefreshToken(refreshToken);
    if (typeof expectedSteamId64 !== 'string' || !/^7656119\d{10}$/.test(expectedSteamId64)) {
      throw new ResolverError('STEAMID64_REQUIRED', 'unavailable');
    }
    session = createSession(clientsFactory(), { connectionTimeoutMs, requestTimeoutMs, expectedSteamId64 });
    await session.connect(refreshToken);
    const matches = await session.recentGames();
    result.reported_count = matches.length;
    const seen = new Set();
    for (const match of matches) {
      const metadata = recentMatchMetadata(match);
      try {
        const shareCode = shareCodeFromRecentMatch(match);
        if (seen.has(shareCode)) continue;
        seen.add(shareCode);
        result.matches.push({ share_code: shareCode, ...metadata });
      } catch (error) {
        result.unencodable_matches.push({ ...metadata, error_code: safeFailure(error).error_code });
      }
    }
    result.matches.sort((a, b) => (b.match_started_at ?? '').localeCompare(a.match_started_at ?? ''));
  } catch (error) {
    Object.assign(result, safeFailure(error));
  } finally {
    await session?.close();
  }
  return result;
}

export async function resolveBatch(input, {
  refreshToken = process.env.STEAM_REFRESH_TOKEN,
  expectedSteamId64 = process.env.STEAMID64,
  connectionTimeoutMs = 45_000,
  requestTimeoutMs = 30_000,
  clientsFactory = defaultClients,
} = {}) {
  // Secret files and clipboard input can include a trailing newline.
  if (typeof refreshToken === 'string') refreshToken = refreshToken.trim();
  if (typeof expectedSteamId64 === 'string') expectedSteamId64 = expectedSteamId64.trim();
  const entries = normalizeEntries(input);
  const results = new Array(entries.length);
  const requests = [];
  for (const [index, entry] of entries.entries()) {
    try { requests.push({ index, request: decodeRequest(entry.share_code) }); }
    catch (error) { results[index] = { ...entry, ...safeFailure(error) }; }
  }
  if (!requests.length) return results;
  let session;
  try {
    validateRefreshToken(refreshToken);
    if (typeof expectedSteamId64 !== 'string' || !/^7656119\d{10}$/.test(expectedSteamId64)) {
      throw new ResolverError('STEAMID64_REQUIRED', 'unavailable');
    }
    session = createSession(clientsFactory(), { connectionTimeoutMs, requestTimeoutMs, expectedSteamId64 });
    await session.connect(refreshToken);
    for (const { index, request } of requests) {
      try { results[index] = { ...entries[index], ...await session.resolve(request) }; }
      catch (error) { results[index] = { ...entries[index], ...safeFailure(error) }; }
    }
  } catch (error) {
    for (const { index } of requests) results[index] ??= { ...entries[index], ...safeFailure(error) };
  } finally {
    await session?.close();
  }
  return results;
}
