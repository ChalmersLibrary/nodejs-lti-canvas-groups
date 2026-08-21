/*
 * With debugLogging on, the launch body and the session are written to the log. The body
 * carries lis_person_sourcedid, which at Chalmers is the personnummer, along with the name,
 * the email and the login id. None of that belongs in info.log or in the Azure log stream.
 *
 * The log module is replaced with a collector before the application is required, so this
 * asserts what would actually have been written rather than what a helper returns.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { signedLaunch } = require('./helpers/lti');

const ROOT = path.join(__dirname, '..');
const DB = path.join(__dirname, 'debug-log-db.sqlite3');
const SECRET = 's3cret';

const PERSONNUMMER = '197503185170';
const EMAIL = 'rolf.johansson@chalmers.se';
const LOGIN_ID = 'roljoh@chalmers.se';
const FULL_NAME = 'Rolf Johansson';

test('debug logging redacts the sensitive launch fields', async (t) => {
    for (const suffix of ['', '-shm', '-wal']) {
        try { fs.unlinkSync(DB + suffix); } catch { /* not there */ }
    }

    const port = 4100 + (process.pid % 90);

    Object.assign(process.env, {
        DB_PATH: DB,
        PORT: String(port),
        NODE_ENV: 'test',
        /* The setting under test. */
        debugLogging: 'true',
        trustProxy: 'true',
        ltiConsumerKeys: `canvas:${SECRET}`,
        SESSION_SECRET: 'test-secret',
        WEBSITE_HOSTNAME: 'localhost',
        canvasBaseUri: 'http://127.0.0.1:1'
    });

    /* Collect everything the application logs, before anything requires the log module. */
    const written = [];
    const log = require(path.join(ROOT, 'log'));
    const realInfo = log.info;
    const realError = log.error;
    log.info = (message) => { written.push(String(message)); };
    log.error = (message) => { written.push(String(message)); };

    t.after(() => {
        log.info = realInfo;
        log.error = realError;
    });

    const { server } = require(path.join(ROOT, 'app.js'));
    await new Promise((r) => setTimeout(r, 600));

    t.after(async () => {
        server.close();
        await require(path.join(ROOT, 'db')).close();
    });

    const body = signedLaunch(`https://127.0.0.1:${port}/launch_lti`, SECRET, {
        oauth_consumer_key: 'canvas',
        tool_consumer_info_product_family_code: 'canvas',
        lis_person_sourcedid: PERSONNUMMER,
        lis_person_contact_email_primary: EMAIL,
        lis_person_name_full: FULL_NAME,
        lis_person_name_given: 'Rolf',
        lis_person_name_family: 'Johansson',
        custom_canvas_user_login_id: LOGIN_ID,
        user_image: 'https://canvas.chalmers.se/images/thumbnails/83533/p2dUFyfSgxspFy2S'
    });
    const payload = new URLSearchParams(body).toString();

    const status = await new Promise((resolve, reject) => {
        const call = http.request({
            host: '127.0.0.1', port, path: '/launch_lti', method: 'POST',
            headers: {
                host: `127.0.0.1:${port}`,
                'x-forwarded-proto': 'https',
                'content-type': 'application/x-www-form-urlencoded',
                'content-length': Buffer.byteLength(payload)
            }
        }, (response) => {
            response.resume();
            response.on('end', () => resolve(response.statusCode));
        });

        call.on('error', reject);
        call.end(payload);
    });

    const logged = written.join('\n');

    await t.test('the launch was accepted, so the debug lines really were written', () => {
        assert.equal(status, 302, 'the launch should have been valid');
        assert.match(logged, /\[LTI\] Launch body:/, 'the body dump should have happened');
        assert.match(logged, /\[LTI\] Data:/, 'the parsed dump should have happened');
    });

    await t.test('the personnummer never reaches the log', () => {
        assert.doesNotMatch(logged, new RegExp(PERSONNUMMER), 'lis_person_sourcedid was logged in clear');
    });

    await t.test('the email, login id and name do not either', () => {
        assert.doesNotMatch(logged, new RegExp(EMAIL));
        assert.doesNotMatch(logged, new RegExp(LOGIN_ID));
        assert.doesNotMatch(logged, new RegExp(FULL_NAME));
    });

    await t.test('they are replaced rather than dropped, so the shape still reads', () => {
        assert.match(logged, /"lis_person_sourcedid":"<redacted>"/);
        assert.match(logged, /"lis_person_contact_email_primary":"<redacted>"/);
    });

    await t.test('what the log is for is still in it', () => {
        /* Opaque ids and the course, which is what a launch is debugged with. */
        assert.match(logged, /"user_id":"lti-user-1"/, 'the opaque LTI user id should be kept');
        assert.match(logged, /"custom_canvas_course_id":"123"/);
        assert.match(logged, /"context_id":"ctx-1"/);
        assert.match(logged, /"roles":/);
        assert.match(logged, /"oauth_signature":/, 'needed for signature problems');
    });

    await t.test('the name ims-lti derives into username is redacted too', () => {
        /* provider.username comes from lis_person_name_given, so it is a name as well. */
        assert.doesNotMatch(logged, /"username":"Rolf"/);
        assert.match(logged, /"username":"<redacted>"/);
    });

    await t.test('the session dump keeps hiding the token as well', () => {
        assert.match(logged, /"token_type":"Bearer"|"token":undefined|"contextId"/);
        assert.doesNotMatch(logged, /"access_token"/);
        assert.doesNotMatch(logged, /"refresh_token"/);
    });
});
