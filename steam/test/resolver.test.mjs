import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import GlobalOffensive from 'globaloffensive';
import SteamUser from 'steam-user';
import { encodeMatch } from 'csgo-sharecode';
import { decodeRequest, isValveReplayUrl, matchTimeMetadata, resolveBatch, safeFailure, validateRefreshToken,
  discoverRecentGames, replayUrlDiagnostic, shareCodeFromRecentMatch } from '../resolver.mjs';

const require = createRequire(import.meta.url);
const { ShareCode } = require('globaloffensive-sharecode');
const Protos = require('globaloffensive/protobufs/generated/_load.js');
const Language = require('globaloffensive/language.js');
const CODE = 'CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK';
const SECOND = encodeMatch({ matchId: 3230642215713767581n, reservationId: 3230647599455273104n, tvPort: 55789 });
const REQUEST = { matchId: '3230642215713767580', outcomeId: '3230647599455273103', token: 55788 };
const URL = 'http://replay123.valve.net/730/003230642215713767580_1_123.dem.bz2';
const TOKEN = `header.${Buffer.from(JSON.stringify({ aud: ['client', 'web'], exp: 4_000_000_000 })).toString('base64url')}.signature`;
const STEAM_ID = '76561198000000000';

function fakeClients(onRequest, { loginError } = {}) {
  const steam = new EventEmitter();
  const gc = new EventEmitter();
  const calls = { requests: [], games: [], loggedOff: false };
  steam.steamID = { getSteamID64: () => STEAM_ID };
  steam.logOn = (details) => {
    calls.logOn = details;
    queueMicrotask(() => loginError ? steam.emit('error', loginError) : steam.emit('loggedOn', {}));
  };
  steam.gamesPlayed = (games, force) => {
    calls.games.push(games);
    if (games.includes(730)) calls.force = force;
    if (games.includes(730)) queueMicrotask(() => gc.emit('connectedToGC'));
  };
  steam.logOff = () => { calls.loggedOff = true; };
  gc.requestGame = (request) => {
    calls.requests.push(request);
    onRequest?.(request, gc, calls);
  };
  return { steam, gc, calls };
}
const options = (clients) => ({ refreshToken: TOKEN, expectedSteamId64: STEAM_ID, clientsFactory: () => clients, connectionTimeoutMs: 200, requestTimeoutMs: 30 });

test('decode preserves uint64 ids and agrees with the GC package decoder', () => {
  assert.deepEqual(decodeRequest(CODE), REQUEST);
  const legacy = new ShareCode(CODE).decode();
  assert.equal(legacy.matchId, REQUEST.matchId);
  assert.equal(legacy.outcomeId, REQUEST.outcomeId);
  assert.equal(Number(legacy.token), REQUEST.token);
  assert.throws(() => decodeRequest('CSGO-00000-00000-00000-00000-00000'));
});

test('installed globaloffensive requestGame accepts a single details object and serializes expected protobuf', () => {
  const steam = new EventEmitter();
  steam.packageName = 'steam-user';
  steam.packageVersion = '5.3.0';
  steam.steamID = true;
  let sent;
  steam.sendToGC = (...args) => { sent = args; };
  const gc = new GlobalOffensive(steam);
  gc.requestGame(REQUEST);
  assert.equal(sent[0], 730);
  assert.equal(sent[1], Language.MatchListRequestFullGameInfo);
  const proto = Protos.CMsgGCCStrike15_v2_MatchListRequestFullGameInfo.decode(sent[3]);
  assert.equal(proto.matchid.toString(), REQUEST.matchId);
  assert.equal(proto.outcomeid.toString(), REQUEST.outcomeId);
  assert.equal(proto.token, REQUEST.token);
  assert.throws(() => gc.requestGame(REQUEST.matchId, REQUEST.outcomeId, REQUEST.token));
});

test('replay URL whitelist restricts hosts, credentials, ports, paths and schemes', () => {
  assert.equal(isValveReplayUrl(URL), true);
  assert.equal(isValveReplayUrl('https://replay1.wmsj.cn/730/abc.dem.bz2'), true);
  assert.equal(isValveReplayUrl('http://replay237.csgo.com.cn/730/abc.dem.bz2'), true);
  for (const invalid of [
    'http://localhost/730/test.dem.bz2',
    'https://replay1.valve.net.evil.test/730/test.dem.bz2',
    'https://user:password@replay1.valve.net/730/test.dem.bz2',
    'https://replay1.valve.net:8443/730/test.dem.bz2',
    'file:///730/test.dem.bz2',
    'https://replay1.valve.net/730/test.dem.bz2?secret=token',
    'https://replay1.valve.net/other/test.dem.bz2',
    'http://replay237.csgo.com.cn.evil.com/730/test.dem.bz2',
  ]) assert.equal(isValveReplayUrl(invalid), false, invalid);
});

test('batch waits for matching GC data, resolves exact ids, cleans up session', async () => {
  const clients = fakeClients((request, gc) => queueMicrotask(() => {
    gc.emit('matchList', [{ matchid: '111', roundstatsall: [{ map: 'http://replay1.valve.net/730/wrong.dem.bz2' }] }]);
    gc.emit('matchList', [{ matchid: request.matchId, matchtime: 1700000000, roundstatsall: [{ map: URL }] }]);
  }));
  const result = await resolveBatch([{ id: 7, share_code: CODE }], {
    ...options(clients), refreshToken: ` ${TOKEN}\n`, expectedSteamId64: `${STEAM_ID}\n`,
  });
  assert.deepEqual(result, [{ id: 7, share_code: CODE, status: 'resolved', url: URL, match_id: REQUEST.matchId,
    match_started_at: '2023-11-14T22:13:20.000Z', match_time_verified: true,
    timestamp_provenance: 'Steam GC matchList.matchtime',
    replay_url_diagnostics: [{host:'replay123.valve.net',scheme:'http:',reason:'ACCEPTED'}], retryable: false }]);
  assert.deepEqual(clients.calls.requests, [REQUEST]);
  assert.deepEqual(clients.calls.logOn, { refreshToken: TOKEN });
  assert.deepEqual(clients.calls.games, [[730], []]);
  assert.equal(clients.calls.force, false);
  assert.equal(clients.calls.loggedOff, true);
});

test('batch supports legacy roundstats URL and distinguishes unavailable from timeout', async () => {
  const clients = fakeClients((request, gc) => {
    if (request.matchId === REQUEST.matchId) queueMicrotask(() => gc.emit('matchList', [{ matchid: request.matchId, roundstats_legacy: { map: URL } }]));
  });
  const results = await resolveBatch([CODE, SECOND], options(clients));
  assert.equal(results[0].status, 'resolved');
  assert.equal(results[0].match_time_verified, false);
  assert.equal(results[0].match_started_at, undefined);
  assert.equal(results[1].status, 'transient');
  assert.equal(results[1].error_code, 'GC_MATCH_TIMEOUT');
  assert.equal(clients.calls.loggedOff, true);

  const noUrl = fakeClients((request, gc) => queueMicrotask(() => gc.emit('matchList', [{ matchid: request.matchId, roundstatsall: [{ map: 'de_dust2' }] }])));
  const [unavailable] = await resolveBatch([CODE], options(noUrl));
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.error_code, 'REPLAY_URL_UNAVAILABLE');
});

test('invalid or absent GC match timestamps never become verified dates', () => {
  for (const matchtime of [undefined, null, 0, -1, '1700000000', 1700000000.5, NaN, 0x100000000]) {
    assert.deepEqual(matchTimeMetadata({ matchtime }), { match_time_verified: false });
  }
});

test('authenticated Steam identity must match STEAMID64 before entering CS2 or requesting matches', async () => {
  const clients = fakeClients(() => assert.fail('must not request matches'));
  clients.steam.steamID = { getSteamID64: () => '76561198000000001' };
  const [row] = await resolveBatch([CODE], options(clients));
  assert.equal(row.status, 'unavailable');
  assert.equal(row.error_code, 'STEAM_ACCOUNT_MISMATCH');
  assert.equal(row.retryable, false);
  assert.deepEqual(clients.calls.games, [[]]);
  assert.equal(clients.calls.loggedOff, true);
});

test('a known active Steam playing session prevents entering CS2 and remains retryable', async () => {
  const clients = fakeClients(() => assert.fail('must not request matches'));
  clients.steam.playingState = { blocked: true, appid: 730 };
  const [row] = await resolveBatch([CODE], options(clients));
  assert.equal(row.status, 'transient');
  assert.equal(row.error_code, 'STEAM_PLAYING_ELSEWHERE');
  assert.equal(row.retryable, true);
  assert.deepEqual(clients.calls.games, [[]]);
  assert.equal(clients.calls.loggedOff, true);
});

test('a playingState event arriving during a pending request aborts safely', async () => {
  const clients = fakeClients(() => queueMicrotask(() => clients.steam.emit('playingState', true, 730)));
  const [row] = await resolveBatch([CODE], options(clients));
  assert.equal(row.error_code, 'STEAM_PLAYING_ELSEWHERE');
  assert.equal(row.status, 'transient');
  assert.equal(clients.calls.loggedOff, true);
});

test('unrelated empty GC messages do not falsely mark a demo unavailable', async () => {
  const clients = fakeClients((request, gc) => queueMicrotask(() => {
    gc.emit('matchList', [], { msgrequestid: 123 });
    gc.emit('matchList', [], { msgrequestid: Language.MatchListRequestFullGameInfo });
  }));
  const [row] = await resolveBatch([CODE], options(clients));
  assert.equal(row.status, 'unavailable');
  assert.equal(row.error_code, 'MATCH_UNAVAILABLE');
});

test('Steam failure reports stable error codes and never reflects upstream credentials', async () => {
  const error = new Error(`Credentials ${TOKEN} or private URL ${URL}`);
  error.eresult = SteamUser.EResult.Revoked;
  const clients = fakeClients(null, { loginError: error });
  const result = await resolveBatch([CODE], options(clients));
  assert.equal(result[0].status, 'expired');
  assert.equal(result[0].error_code, 'STEAM_REFRESH_TOKEN_REJECTED');
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal(JSON.stringify(result).includes(URL), false);
  assert.equal(clients.calls.loggedOff, true);
  assert.equal(clients.calls.requests.length, 0);
  assert.equal(safeFailure(new Error('secret')).error_code, 'STEAM_CONNECTION_FAILED');
});

test('invalid codes and missing/expired credentials never create a Steam connection', async () => {
  let created = false;
  const clientsFactory = () => { created = true; throw new Error('must not call'); };
  const [invalid] = await resolveBatch(['invalid'], { refreshToken: TOKEN, clientsFactory });
  assert.equal(invalid.error_code, 'INVALID_SHARE_CODE');
  const [missing] = await resolveBatch([CODE], { refreshToken: '', clientsFactory });
  assert.equal(missing.error_code, 'STEAM_REFRESH_TOKEN_MISSING');
  const expired = `a.${Buffer.from(JSON.stringify({ aud: ['client'], exp: 1 })).toString('base64url')}.b`;
  const [stale] = await resolveBatch([CODE], { refreshToken: expired, clientsFactory });
  assert.equal(stale.status, 'expired');
  assert.equal(created, false);
  assert.throws(() => validateRefreshToken('invalid'), /STEAM_REFRESH_TOKEN_INVALID/);
});

test('GC disconnect marks pending and later requests transient and tears down timers', async () => {
  const clients = fakeClients((request, gc) => queueMicrotask(() => gc.emit('disconnectedFromGC', 0)));
  clients.gc._helloTimer = setTimeout(() => assert.fail('hello timer was not cleared'), 1000);
  const results = await resolveBatch([CODE, SECOND], options(clients));
  assert.deepEqual(results.map((row) => row.error_code), ['GC_DISCONNECTED', 'GC_DISCONNECTED']);
  assert.equal(clients.gc._helloTimer, null);
  assert.equal(clients.calls.loggedOff, true);
});

test('recent-game sharecodes use terminal reservation and preserve uint64 identity', () => {
  const record={matchid:REQUEST.matchId, watchablematchinfo:{tv_port:55788,reservation_id:'999'},
    roundstatsall:[{reservationid:'100'},{reservationid:REQUEST.outcomeId}]};
  assert.equal(shareCodeFromRecentMatch(record),CODE);
  assert.equal(shareCodeFromRecentMatch({...record,watchablematchinfo:{tv_port:599906796}}),CODE);
  assert.throws(()=>shareCodeFromRecentMatch({...record,roundstatsall:[]}),/FIELDS_MISSING/);
  assert.throws(()=>shareCodeFromRecentMatch({...record,matchid:Number(REQUEST.matchId)}),/FIELDS_MISSING/);
});

test('installed recent-game request serializes only the target account id', () => {
  const steam=new EventEmitter();
  steam.packageName='steam-user'; steam.packageVersion='5.3.0'; steam.steamID=true;
  let sent;
  steam.sendToGC=(...args)=>{sent=args;};
  const gc=new GlobalOffensive(steam);
  gc.requestRecentGames(STEAM_ID);
  assert.equal(sent[1],Language.MatchListRequestRecentUserGames);
  const request=Protos.CMsgGCCStrike15_v2_MatchListRequestRecentUserGames.decode(sent[3]);
  assert.equal(request.accountid,Number(BigInt(STEAM_ID)-76561197960265728n));
});

test('recent discovery matches request kind and account, deduplicates, reports missing fields and cleans up', async () => {
  const clients=fakeClients();
  clients.gc.requestRecentGames=(sid)=>{
    assert.equal(sid,STEAM_ID);
    queueMicrotask(()=>{
      const data={msgrequestid:Language.MatchListRequestRecentUserGames,
        accountid:Number(BigInt(STEAM_ID)-76561197960265728n)};
      const match={matchid:REQUEST.matchId,matchtime:1700000000,
        watchablematchinfo:{tv_port:REQUEST.token},roundstats_legacy:{reservationid:REQUEST.outcomeId,map:URL}};
      clients.gc.emit('matchList',[match],{...data,accountid:1});
      clients.gc.emit('matchList',[match],{...data,msgrequestid:0});
      clients.gc.emit('matchList',[match,match,{matchid:'123',matchtime:1700000001}],data);
    });
  };
  const result=await discoverRecentGames(options(clients));
  assert.equal(result.status,'discovered'); assert.equal(result.reported_count,3);
  assert.equal(result.matches.length,1); assert.equal(result.matches[0].share_code,CODE);
  assert.equal(result.unencodable_matches.length,1);
  assert.equal(result.unencodable_matches[0].error_code,'GC_SHARE_CODE_FIELDS_MISSING');
  assert.equal(JSON.stringify(result).includes(URL),false);
  assert.equal(clients.calls.requests.length,0); assert.equal(clients.calls.loggedOff,true);
});

test('recent discovery empty response is valid, unrelated response times out, bad auth is explicit', async () => {
  const clients=fakeClients();
  clients.gc.requestRecentGames=()=>queueMicrotask(()=>clients.gc.emit('matchList',[],{
    msgrequestid:Language.MatchListRequestRecentUserGames,accountid:Number(BigInt(STEAM_ID)-76561197960265728n)}));
  assert.equal((await discoverRecentGames(options(clients))).status,'discovered');
  const silent=fakeClients(); silent.gc.requestRecentGames=()=>{};
  assert.equal((await discoverRecentGames(options(silent))).error_code,'GC_RECENT_MATCHES_TIMEOUT');
  assert.equal((await discoverRecentGames({refreshToken:'bad'})).error_code,'STEAM_REFRESH_TOKEN_INVALID');
});

test('rejected replay diagnostics never persist raw credentials, paths or query values', () => {
  const result=replayUrlDiagnostic('https://user:password@unexpected.example/secret-path?token=sensitive#private');
  assert.deepEqual(result,{host:'unexpected.example',scheme:'https:',reason:'CREDENTIALS_NOT_ALLOWED'});
  assert.equal(JSON.stringify(result).includes('sensitive'),false);
  assert.equal(JSON.stringify(result).includes('password'),false);
});

test('unexpected replay host is a configuration gap, not a missing or expired replay', async () => {
  const clients=fakeClients((request,gc)=>queueMicrotask(()=>gc.emit('matchList',[{
    matchid:request.matchId,roundstatsall:[{map:'http://unexpected.example/730/match.dem.bz2'}]}])));
  const [row]=await resolveBatch([CODE],options(clients));
  assert.equal(row.error_code,'REPLAY_HOST_NOT_ALLOWED');
  assert.equal(row.replay_url_diagnostics[0].host,'unexpected.example');
});
