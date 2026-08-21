/*
 * The LTI launch signature is computed over the launch url as the application sees it, so
 * it only matches when the protocol, host, port and path are exactly what Canvas signed.
 * Behind an https tunnel to a local machine that is not automatic, and the failure says
 * only "Invalid Signature", which points at the shared secret rather than the url.
 *
 * node:http rather than fetch, because undici refuses to set the Host header and that is
 * the header the signature depends on.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { signedLaunch } = require('./helpers/lti');

const ROOT = path.join(__dirname, '..');
const DB = path.join(__dirname, 'launch-signature-db.sqlite3');
const SECRET = 's3cret';
const TUNNEL = 'tunnel.example.com';

const request = (port, headers, payload) => new Promise((resolve, reject) => {
    const call = http.request({
        host: '127.0.0.1',
        port,
        path: '/launch_lti',
        method: 'POST',
        headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'content-length': Buffer.byteLength(payload),
            ...headers
        }
    }, (response) => {
        response.resume();
        response.on('end', () => resolve({
            status: response.statusCode,
            setCookie: (response.headers['set-cookie'] ?? [])[0]
        }));
    });

    call.on('error', reject);
    call.end(payload);
});

const post = async (port, headers, payload) => (await request(port, headers, payload)).status;
const postWithCookie = (port, headers, payload) => request(port, headers, payload);

test('a launch signed for an https tunnel validates when trust proxy is on', async (t) => {
    for (const suffix of ['', '-shm', '-wal']) {
        try { fs.unlinkSync(DB + suffix); } catch { /* not there */ }
    }

    const port = 3700 + (process.pid % 200);

    Object.assign(process.env, {
        DB_PATH: DB,
        PORT: String(port),
        NODE_ENV: 'test',
        /* The setting under test: without it req.protocol stays http. */
        trustProxy: 'true',
        ltiConsumerKeys: `canvas:${SECRET}`,
        SESSION_SECRET: 'test-secret',
        WEBSITE_HOSTNAME: 'localhost',
        canvasBaseUri: 'http://127.0.0.1:1'
    });

    const { server } = require(path.join(ROOT, 'app.js'));
    await new Promise((r) => setTimeout(r, 600));

    t.after(async () => {
        server.close();
        await require(path.join(ROOT, 'db')).close();
    });

    const launchPayloadFor = (url) => new URLSearchParams(signedLaunch(url, SECRET, {
        oauth_consumer_key: 'canvas',
        tool_consumer_info_product_family_code: 'canvas'
    })).toString();

    /* Canvas is configured with the tunnel url and signs that. */
    const launchPayload = () => launchPayloadFor(`https://${TUNNEL}/launch_lti`);

    await t.test('the tunnel passes the Host through and says the protocol was https', async () => {
        const status = await post(port, { host: TUNNEL, 'x-forwarded-proto': 'https' }, launchPayload());

        assert.equal(status, 302, 'the launch should be accepted and redirected');
    });

    await t.test('without x-forwarded-proto the url is signed as http and is rejected', async () => {
        const status = await post(port, { host: TUNNEL }, launchPayload());

        assert.equal(status, 401, 'http instead of https must not validate');
    });

    await t.test('x-forwarded-host alone is not enough, since ims-lti reads the Host header', async () => {
        const status = await post(port, { 'x-forwarded-proto': 'https', 'x-forwarded-host': TUNNEL }, launchPayload());

        assert.equal(status, 401, 'the Host header, not x-forwarded-host, is what gets signed');
    });

    /* The cookie is Secure because it has to be SameSite=None for the Canvas iframe, and
       express-session will not put a Secure cookie on a connection it does not consider
       https. So an iframed launch cannot hold a session over plain http, whatever the cookie
       options say, and the tunnel is not optional for working on the launch locally. */
    await t.test('an https launch gets a session cookie, and it is Secure', async () => {
        const { setCookie } = await postWithCookie(port, { host: TUNNEL, 'x-forwarded-proto': 'https' }, launchPayload());

        assert.ok(setCookie, 'a session cookie should have been set');
        assert.match(setCookie, /;\s*Secure/i, setCookie);
        assert.match(setCookie, /;\s*SameSite=None/i, setCookie);
    });

    await t.test('a plain http launch gets no session cookie at all', async () => {
        /* Signed for the http url, so the launch itself is valid and only the cookie is at issue. */
        const { status, setCookie } = await postWithCookie(port, { host: `localhost:${port}` },
            launchPayloadFor(`http://localhost:${port}/launch_lti`));

        assert.equal(status, 302, 'the launch itself should be accepted');

        assert.equal(setCookie, undefined,
            `express-session must not send a Secure cookie over http, got: ${setCookie}`);
    });
});
