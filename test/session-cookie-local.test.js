/*
 * The session cookie for local development against mock-lti.json.
 *
 * The iframe configuration (SameSite=None, Secure) cannot be stored over http, so with it
 * the cookie is dropped on every request. The mocked session is rebuilt on each request, so
 * the tool still works, but every page load writes a new session row. Opened directly in a
 * browser there is no iframe, so a first-party Lax cookie is both enough and the only kind
 * that can be stored.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DB = path.join(__dirname, 'session-cookie-local-db.sqlite3');
const MOCK = path.join(ROOT, 'mock-lti.json');

test('local development with mock-lti.json keeps one session across requests', async (t) => {
    for (const suffix of ['', '-shm', '-wal']) {
        try { fs.unlinkSync(DB + suffix); } catch { /* not there */ }
    }

    /* mock-lti.json is read from the working directory and is gitignored, so write one for
       the test if the developer has none, and put back whatever was there afterwards. */
    const existingMock = fs.existsSync(MOCK) ? fs.readFileSync(MOCK) : null;

    fs.writeFileSync(MOCK, JSON.stringify({
        context_id: 'ctx-mock',
        context_title: 'Mockkurs',
        user_id: 'mock-user-1',
        lis_person_name_full: 'Mock Teacher',
        custom_canvas_user_id: '4711',
        custom_canvas_course_id: '123',
        custom_canvas_enrollment_state: 'active',
        custom_canvas_api_domain: '127.0.0.1'
    }));

    t.after(() => {
        if (existingMock) {
            fs.writeFileSync(MOCK, existingMock);
        }
        else {
            fs.unlinkSync(MOCK);
        }
    });

    const port = 3900 + (process.pid % 90);

    Object.assign(process.env, {
        DB_PATH: DB,
        PORT: String(port),
        NODE_ENV: 'development',
        /* Together these two are what turns on the mocked local session. */
        localCanvasDeveloperToken: 'dev-token-abc',
        canvasBaseUri: 'http://127.0.0.1:1',
        SESSION_SECRET: 'test-secret',
        ltiConsumerKeys: 'canvas:s3cret',
        WEBSITE_HOSTNAME: 'localhost'
    });

    process.chdir(ROOT);
    const { server } = require(path.join(ROOT, 'app.js'));
    const db = require(path.join(ROOT, 'db'));
    await new Promise((r) => setTimeout(r, 600));

    t.after(async () => {
        server.close();
        await db.close();
    });

    /* /loading needs a session but no Canvas, so it exercises the cookie without the api. */
    const get = (cookie) => new Promise((resolve, reject) => {
        const call = http.request({
            host: '127.0.0.1', port, path: '/loading/groups', method: 'GET',
            headers: cookie ? { cookie } : {}
        }, (response) => {
            response.resume();
            response.on('end', () => resolve({
                status: response.statusCode,
                setCookie: (response.headers['set-cookie'] ?? [])[0]
            }));
        });

        call.on('error', reject);
        call.end();
    });

    const first = await get();

    await t.test('a cookie is set over plain http, unlike the iframe configuration', () => {
        assert.ok(first.setCookie, 'no session cookie was set');
        assert.match(first.setCookie, /;\s*SameSite=Lax/i, first.setCookie);
        assert.doesNotMatch(first.setCookie, /;\s*Secure/i, 'Secure cannot be stored over http');
    });

    const cookie = first.setCookie.split(';')[0];

    await t.test('the same session is reused rather than one per request', async () => {
        for (let i = 0; i < 4; i++) {
            await get(cookie);
        }

        const { c } = await db.sql.get('SELECT count(*) AS c FROM sessions');

        assert.equal(c, 1, `expected one session row after five requests, found ${c}`);
    });
});
