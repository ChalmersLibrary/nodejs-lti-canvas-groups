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

const post = (port, headers, payload) => new Promise((resolve, reject) => {
    const request = http.request({
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
        response.on('end', () => resolve(response.statusCode));
    });

    request.on('error', reject);
    request.end(payload);
});

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

    /* Canvas is configured with the tunnel url and signs that. */
    const launchPayload = () => new URLSearchParams(signedLaunch(`https://${TUNNEL}/launch_lti`, SECRET, {
        oauth_consumer_key: 'canvas',
        tool_consumer_info_product_family_code: 'canvas'
    })).toString();

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
});
