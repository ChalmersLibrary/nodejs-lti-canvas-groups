/*
 * The session cookie as it is sent in production.
 *
 * The tool is always inside an iframe in Canvas, so its cookie is a third party cookie.
 * Browsers are restricting those unless they carry Partitioned, and if the cookie stops
 * being stored then nobody can launch the tool at all, so the attributes are worth an
 * assertion rather than a code review.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { signedLaunch } = require('./helpers/lti');

const ROOT = path.join(__dirname, '..');
const DB = path.join(__dirname, 'session-cookie-db.sqlite3');
const CONSUMER_SECRET = 's3cret';

test('the production session cookie is Secure, SameSite=None and Partitioned', async (t) => {
    for (const suffix of ['', '-shm', '-wal']) {
        try { fs.unlinkSync(DB + suffix); } catch { /* not there */ }
    }

    const port = 3600 + (process.pid % 300);

    Object.assign(process.env, {
        DB_PATH: DB,
        PORT: String(port),
        /* The production branch of the session options is the one under test. */
        NODE_ENV: 'production',
        SESSION_NAME: 'groupTool.sid',
        SESSION_SECRET: 'test-secret',
        ltiConsumerKeys: `testconsumer:${CONSUMER_SECRET}`,
        oauthClientId: '10000001',
        oauthClientSecret: 'oauth-secret',
        WEBSITE_HOSTNAME: 'localhost',
        canvasBaseUri: 'http://127.0.0.1:1'
    });

    const { server } = require(path.join(ROOT, 'app.js'));
    await new Promise((r) => setTimeout(r, 600));

    t.after(async () => {
        server.close();
        await require(path.join(ROOT, 'db')).close();
    });

    /* A secure cookie is only sent over https. The application sets trust proxy in
       production, which is how it works behind the Azure front end, so x-forwarded-proto
       is what tells it the original request was https. The signature has to be built over
       that same https url, because ims-lti signs req.protocol. */
    const launchUrl = `https://127.0.0.1:${port}/launch_lti`;
    const body = signedLaunch(launchUrl, CONSUMER_SECRET);

    const response = await fetch(`http://127.0.0.1:${port}/launch_lti`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'x-forwarded-proto': 'https',
            'x-forwarded-host': `127.0.0.1:${port}`,
            host: `127.0.0.1:${port}`
        },
        body: new URLSearchParams(body).toString()
    });

    const setCookie = (response.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('groupTool.sid='));

    await t.test('the launch was accepted, so a session was created', () => {
        assert.equal(response.status, 302, `status ${response.status}`);
        assert.ok(setCookie, `no session cookie in ${JSON.stringify(response.headers.getSetCookie?.() ?? [])}`);
    });

    await t.test('Partitioned, so the cookie survives third party cookie restrictions', () => {
        assert.match(setCookie, /;\s*Partitioned/i, setCookie);
    });

    await t.test('SameSite=None, so it is sent at all inside the Canvas iframe', () => {
        assert.match(setCookie, /;\s*SameSite=None/i, setCookie);
    });

    await t.test('Secure, which Partitioned and SameSite=None both require', () => {
        assert.match(setCookie, /;\s*Secure/i, setCookie);
    });

    await t.test('HttpOnly, so injected script cannot read the session id', () => {
        assert.match(setCookie, /;\s*HttpOnly/i, setCookie);
    });
});
