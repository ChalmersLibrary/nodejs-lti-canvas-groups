/* End-to-end test: signed LTI launch -> OAuth -> /groups -> csv, against a mocked Canvas. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const { signLaunch, launchBody: buildLaunchBody, Jar } = require('./helpers/lti');

const ROOT = path.join(__dirname, '..');

const CONSUMER_KEY = 'testconsumer';
const CONSUMER_SECRET = 's3cret';

let refreshCount = 0;
let apiCalls = [];
let currentAccessToken = 'access-token-1';
/* Set to true to make the next api call answer 401 once, to exercise the refresh path. */
let rejectNextApiCall = false;

/* ---------- mocked Canvas ---------- */
const canvasServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (code, body, headers = {}) => {
    res.writeHead(code, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === '/login/oauth2/token') {
    let raw = '';
    req.on('data', (c) => raw += c);
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      if (body.grant_type === 'refresh_token') {
        refreshCount++;
        currentAccessToken = 'access-token-refreshed-' + refreshCount;
        return send(200, { access_token: currentAccessToken, token_type: 'Bearer', expires_in: 3600 });
      }
      currentAccessToken = 'access-token-1';
      return send(200, { access_token: currentAccessToken, token_type: 'Bearer', refresh_token: 'refresh-token-1', expires_in: 3600 });
    });
    return;
  }

  apiCalls.push(url.pathname + url.search);

  if (rejectNextApiCall) {
    rejectNextApiCall = false;
    res.writeHead(401, { 'www-authenticate': 'Bearer realm="canvas-lms"', 'content-type': 'application/json' });
    return res.end(JSON.stringify({ errors: [{ message: 'user authorisation required' }] }));
  }

  const auth = req.headers.authorization;
  if (auth !== 'Bearer ' + currentAccessToken && !auth?.endsWith('system-token')) {
    res.writeHead(401, { 'www-authenticate': 'Bearer realm="canvas-lms"', 'content-type': 'application/json' });
    return res.end(JSON.stringify({ errors: [{ message: 'stale token: ' + auth }] }));
  }

  // /api/v1/courses/:id/group_categories  -> two pages, to exercise the Link header
  if (/^\/api\/v1\/courses\/\d+\/group_categories$/.test(url.pathname)) {
    if (url.searchParams.get('page') === '2') {
      return send(200, [{ id: 902, name: 'Seminars', self_signup: null }]);
    }
    const next = `<http://127.0.0.1:${canvasPort}${url.pathname}?per_page=50&page=2>; rel="next"`;
    return send(200, [{ id: 901, name: 'Labs / Groups', self_signup: 'enabled' }], { link: next });
  }

  if (/^\/api\/v1\/group_categories\/901\/groups$/.test(url.pathname)) {
    return send(200, [{ id: 11, name: 'Lab 1', description: 'd1', group_category_id: 901 }, { id: 12, name: 'Lab 2', description: 'd2', group_category_id: 901 }]);
  }
  if (/^\/api\/v1\/group_categories\/902\/groups$/.test(url.pathname)) {
    return send(200, [{ id: 21, name: 'Sem 1', description: 'd3', group_category_id: 902 }]);
  }
  if (/^\/api\/v1\/group_categories\/999\/groups$/.test(url.pathname)) {
    return send(404, { errors: [{ message: 'not found' }] });   // deleted category
  }

  if (/^\/api\/v1\/groups\/\d+\/users$/.test(url.pathname)) {
    const gid = url.pathname.split('/')[4];
    return send(200, [
      { id: Number(gid) * 10, name: 'Anna Andersson', sortable_name: 'Andersson, Anna', email: `a${gid}@student.chalmers.se`, login_id: `a${gid}@student.chalmers.se`, avatar_url: 'x' },
      { id: Number(gid) * 10 + 1, name: 'Bo Bengtsson', sortable_name: 'Bengtsson, Bo', email: `b${gid}@chalmers.se`, login_id: `b${gid}@chalmers.se`, avatar_url: 'y' }
    ]);
  }

  if (/^\/api\/v1\/courses\/\d+\/assignments$/.test(url.pathname)) {
    return send(200, [
      { id: 500, name: 'Quiz', grading_type: 'points', published: true, points_possible: 10, locked_for_user: false },
      { id: 501, name: 'Draft', grading_type: 'points', published: false, points_possible: 10 },
      { id: 502, name: 'Letter', grading_type: 'letter_grade', published: true }
    ]);
  }

  if (/^\/api\/v1\/courses\/\d+\/assignments\/\d+\/submissions$/.test(url.pathname)) {
    return send(200, [{ user_id: 777, workflow_state: 'graded', submitted_at: '2026-01-01', score: 9, entered_score: 9 }]);
  }

  return send(404, { errors: [{ message: 'no mock for ' + url.pathname }] });
});

let canvasPort;
let appPort;

test('LTI launch, OAuth, groups view and exports', async (t) => {
  /* The steps share one session on purpose: this is one journey through the tool. */
  const check = (name, condition, detail = '') => t.test(name, () => {
    assert.ok(condition, detail || name);
  });
  await new Promise((r) => canvasServer.listen(0, r));
  canvasPort = canvasServer.address().port;
  const canvasBase = `http://127.0.0.1:${canvasPort}`;

  appPort = 3200 + (process.pid % 300);

  /* Never touch db/tokens.sqlite3; that is the database being developed against. */
  const testDbPath = path.join(__dirname, 'test-tokens.sqlite3');
  for (const suffix of ['', '-shm', '-wal']) {
    try { require('node:fs').unlinkSync(testDbPath + suffix); } catch { /* not there */ }
  }

  Object.assign(process.env, {
    DB_PATH: testDbPath,
    PORT: String(appPort),
    NODE_ENV: 'test',
    /* The session cookie is Secure, so the requests below have to look like https. In
       production the Azure front end terminates https and forwards this header; here the
       test plays that part. Without it express-session sends no cookie and nothing that
       needs a session works. */
    trustProxy: 'true',
    canvasBaseUri: canvasBase,
    ltiConsumerKeys: `${CONSUMER_KEY}:${CONSUMER_SECRET}`,
    oauthClientId: '10000001',
    oauthClientSecret: 'oauth-secret',
    oauthClientState: 'teststate',
    WEBSITE_HOSTNAME: 'localhost',
    adminCanvasUserIds: 'lti-user-1',
    systemApiToken: 'system-token',
    SESSION_SECRET: 'test-secret',
    canvasApiCacheSecondsTTL: '900'
  });

  process.chdir(ROOT);
  const { server: appServer } = require(path.join(ROOT, 'app.js'));
  await new Promise((r) => setTimeout(r, 800));

  t.after(async () => {
    appServer.close();
    canvasServer.close();
    await require(path.join(ROOT, 'db')).close();
  });

  /* Start from a clean slate; a token left in the db by an earlier run would make the */
  /* launch skip the OAuth flow that is being tested.                                  */
  const dbInit = require(path.join(ROOT, 'db'));
  await dbInit.ready;
  await dbInit.sql.run('DELETE FROM tokens');
  await dbInit.sql.run('DELETE FROM sessions');
  await dbInit.sql.run('DELETE FROM self_signup_config');

  const appBase = `http://127.0.0.1:${appPort}`;
  const jar = new Jar();

  const req = async (method, url, { body, contentType, follow = false } = {}) => {
    const res = await fetch(appBase + url, {
      method,
      redirect: 'manual',
      headers: {
        cookie: jar.header(),
        'x-forwarded-proto': 'https',
        ...(contentType ? { 'content-type': contentType } : {})
      },
      body
    });
    jar.store(res);
    if (follow && res.status >= 300 && res.status < 400) {
      return req('GET', res.headers.get('location'), { follow });
    }
    return res;
  };

  /* 1. Launch */
  const launchUrl = `https://127.0.0.1:${appPort}/launch_lti`;
  const launchBody = buildLaunchBody({ oauth_consumer_key: CONSUMER_KEY });
  launchBody.oauth_signature = signLaunch(launchUrl, launchBody, CONSUMER_SECRET);

  const launchRes = await req('POST', '/launch_lti', {
    body: new URLSearchParams(launchBody).toString(),
    contentType: 'application/x-www-form-urlencoded'
  });
  await check('LTI launch accepted and redirected', launchRes.status === 302, `${launchRes.status} -> ${launchRes.headers.get('location')}`);
  await check('launch with no token goes to /oauth', launchRes.headers.get('location') === '/oauth');

  /* 2. Replay the same nonce -> must be rejected */
  const replay = await req('POST', '/launch_lti', {
    body: new URLSearchParams(launchBody).toString(),
    contentType: 'application/x-www-form-urlencoded'
  });
  await check('replayed nonce is rejected', replay.status >= 400, String(replay.status));

  /* 3. OAuth flow */
  const oauthRedirect = await req('GET', '/oauth');
  await check('/oauth redirects to Canvas', (oauthRedirect.headers.get('location') ?? '').startsWith(canvasBase + '/login/oauth2/auth'), oauthRedirect.headers.get('location'));

  const tokenRes = await req('GET', '/oauth/redirect?code=thecode&state=teststate');
  await check('token exchange redirects to loading', tokenRes.headers.get('location') === '/loading/groups', `${tokenRes.status} ${tokenRes.headers.get('location')}`);

  /* 4. The groups page */
  apiCalls = [];
  const groups = await req('GET', '/groups');
  const groupsHtml = await groups.text();
  await check('/groups renders', groups.status === 200, String(groups.status));
  await check('/groups shows both categories', groupsHtml.includes('Labs / Groups') && groupsHtml.includes('Seminars'));
  await check('/groups shows group members', groupsHtml.includes('Andersson, Anna'));
  await check('pagination followed (page=2 fetched)', apiCalls.some((c) => c.includes('page=2')), apiCalls.join(' | '));

  /* 5. Cache: second load must not call Canvas again */
  apiCalls = [];
  const groups2 = await req('GET', '/groups');
  await check('/groups is served from cache', groups2.status === 200 && apiCalls.length === 0, `${apiCalls.length} api calls`);

  /* 6. Session survived across requests (it is in sqlite now) */
  const dbmod = require(path.join(ROOT, 'db'));
  const sessionRows = await dbmod.sql.all('SELECT sid, expires_at_utc FROM sessions');
  await check('session stored in sqlite', sessionRows.length >= 1, `${sessionRows.length} row(s)`);

  /* 7. csv exports */
  const csv = await req('GET', '/csv/category/901/Labs%20Groups');
  /* Raw bytes: res.text() decodes utf-8 and strips the BOM, so it can never see it. */
  const csvBytes = new Uint8Array(await csv.arrayBuffer());
  const csvText = new TextDecoder('utf-8', { ignoreBOM: true }).decode(csvBytes);
  await check('csv export works', csv.status === 200 && csvText.includes('Andersson, Anna'), `${csv.status} ${csvText.slice(0, 60)}`);
  await check('csv has utf-8 BOM (Excel needs it)', csvBytes[0] === 0xEF && csvBytes[1] === 0xBB && csvBytes[2] === 0xBF, [...csvBytes.slice(0, 3)].join(','));
  await check('csv header follows the BOM', csvText.startsWith('\ufeffGroup;Student;Email address'));

  const zoom = await req('GET', '/csv/zoom/category/901/Labs%20Groups');
  const zoomText = await zoom.text();
  await check('zoom csv maps student addresses', zoom.status === 200 && zoomText.includes('@student.chalmers.se'), zoomText.slice(0, 80).replace(/\n/g, '\\n'));

  /* 8. Self signup config round trip */
  const put = await req('PUT', '/api/config/self-signup/901', {
    body: JSON.stringify({ assignment_id: 500, description: 'Pass the quiz', min_points: 5 }),
    contentType: 'application/json'
  });
  const putBody = await put.json();
  await check('PUT self-signup rule', put.status === 200 && putBody.success === true, JSON.stringify(putBody).slice(0, 120));

  const wildcard = await req('GET', '/api/config/self-signup/901/Labs%2FGroups');
  const wildcardBody = await wildcard.json();
  await check('express 5 wildcard route (name with slash)', wildcard.status === 200 && wildcardBody.category.name === 'Labs/Groups', JSON.stringify(wildcardBody.category));
  await check('only points+published assignments listed', wildcardBody.assignments.length === 1 && wildcardBody.assignments[0].id === 500, JSON.stringify(wildcardBody.assignments));
  await check('current rule returned', wildcardBody.current?.assignment_id === 500, JSON.stringify(wildcardBody.current));

  /* 9. Public anonymous api with the system token */
  const pub = await req('GET', '/api/self-signup/123/777');
  const pubBody = await pub.json();
  await check('public self-signup api', pub.status === 200 && pubBody.success === true && pubBody.groups.length === 2, JSON.stringify(pubBody).slice(0, 160));
  await check('public api computed passed', pubBody.groups[0]?.passed === true, JSON.stringify(pubBody.groups[0]));

  /* 10. Admin pages */
  const stats = await req('GET', '/stats');
  const statsHtml = await stats.text();
  await check('/stats for admin', stats.status === 200, String(stats.status));

  /* The refresh token is long lived and gives full API access as the user, so no admin
     page may print it. currentAccessToken is whatever the mocked Canvas last handed out. */
  await check('/stats does not leak the access token', !statsHtml.includes(currentAccessToken), currentAccessToken);
  await check('/stats does not leak the refresh token', !statsHtml.includes('refresh-token-1'));
  await check('/stats shows token fingerprints instead', statsHtml.includes('sha256:') && statsHtml.includes('refresh_token_fingerprint'));

  const sqliteTest = await req('GET', '/test/sqlite3');
  const sqliteJson = await sqliteTest.json();
  await check('/test/sqlite3 fingerprints the token it read back',
    String(sqliteJson.users.single?.access_token ?? '').startsWith('sha256:'),
    JSON.stringify(sqliteJson.users.single));
  await check('/test/sqlite3 client list carries no raw token fields',
    sqliteJson.users.db.every((u) => !('api_token' in u) && !('refresh_token' in u)),
    JSON.stringify(sqliteJson.users.db[0]));
  const jsonStats = await req('GET', '/json/stats');
  const jsonStatsBody = await jsonStats.json();
  await check('/json/stats reports caches', jsonStats.status === 200 && jsonStatsBody.cache_stats.length > 0, JSON.stringify(jsonStatsBody).slice(0, 160));

  /* 11. Clear cache, then a 401 from Canvas must trigger exactly one refresh and recover */
  await req('GET', '/api/config/clear-cache/123');
  const before = refreshCount;
  rejectNextApiCall = true;
  apiCalls = [];
  const afterRefresh = await req('GET', '/groups');
  const afterRefreshHtml = await afterRefresh.text();
  await check('recovers from a 401 by refreshing the token', afterRefresh.status === 200 && afterRefreshHtml.includes('Andersson, Anna'), String(afterRefresh.status));
  await check('exactly one refresh happened', refreshCount === before + 1, `${before} -> ${refreshCount}`);

  /* 12. Deleted category (404) is treated as empty, not as an error */
  const deleted = await req('GET', '/csv/category/999/Gone');
  await check('404 category yields empty csv, not 500', deleted.status === 200, String(deleted.status));

  /* 13. Concurrent identical requests share one round of API calls */
  await req('GET', '/api/config/clear-cache/123');
  apiCalls = [];
  await Promise.all([req('GET', '/groups'), req('GET', '/groups'), req('GET', '/groups')]);
  /* First pages only; page 2 of a collection belongs to the same request. */
  const categoryCalls = apiCalls.filter((c) => c.includes('group_categories?') && !c.includes('page=2')).length;
  await check('concurrent loads deduplicated', categoryCalls === 1, `${categoryCalls} group_categories request(s), ${apiCalls.length} api calls`);
  await check('three concurrent loads cost one load', apiCalls.length === 7, `${apiCalls.length} api calls, expected 7`);

  /* 14. The deploy day path: sessions are gone but the tokens are still in the database.
     Changing the session store throws away every active session, so every user comes back
     through a launch with no session and a token that is only in the database. They must
     not be sent through OAuth again. */
  await dbInit.sql.run('DELETE FROM sessions');

  const storedToken = await dbInit.sql.get("SELECT api_token FROM tokens WHERE user_id = 'lti-user-1'");
  await check('token still in the database after the sessions are dropped', storedToken?.api_token != null, JSON.stringify(storedToken));

  const freshJar = new Jar();
  const relaunchBody = {
    ...launchBody,
    oauth_nonce: crypto.randomBytes(12).toString('hex'),
    oauth_timestamp: String(Math.floor(Date.now() / 1000))
  };
  relaunchBody.oauth_signature = signLaunch(launchUrl, relaunchBody, CONSUMER_SECRET);

  const relaunch = await fetch(appBase + '/launch_lti', {
    method: 'POST',
    redirect: 'manual',
    headers: {
      cookie: freshJar.header(),
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-proto': 'https'
    },
    body: new URLSearchParams(relaunchBody).toString()
  });
  freshJar.store(relaunch);

  await check('launch with no session restores the token from the database',
    relaunch.headers.get('location') === '/loading/groups',
    `${relaunch.status} -> ${relaunch.headers.get('location')}`);

  const relaunchGroups = await fetch(appBase + '/groups', {
    headers: { cookie: freshJar.header(), 'x-forwarded-proto': 'https' },
    redirect: 'manual'
  });
  await check('and the groups page works straight away', relaunchGroups.status === 200, String(relaunchGroups.status));

});
