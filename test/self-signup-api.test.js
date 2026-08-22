/*
 * The anonymous self signup endpoint, which a student's browser calls with no session.
 *
 * Every other route learns which Canvas to talk to from the LTI launch. This one cannot, so
 * without a configured domain it used to build a relative url and fail with
 * "TypeError: Invalid URL", which says nothing about the cause.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DB = path.join(__dirname, 'self-signup-api-db.sqlite3');

const COURSE = 29889;
const CATEGORY = 15207;
const ASSIGNMENT = 95667;
const STUDENT = 1618;

/* A second set of ids, so the case with nothing configured cannot be answered from the cache
   that the first case fills. */
const OTHER_COURSE = 40000;
const OTHER_CATEGORY = 40001;
const OTHER_ASSIGNMENT = 40002;

let apiCalls = [];

const canvasServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    apiCalls.push(url.pathname);

    const send = (body) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
    };

    if (new RegExp(`/group_categories/(${CATEGORY}|${OTHER_CATEGORY})/groups$`).test(url.pathname)) {
        return send([{ id: 228462, name: 'Group 1', group_category_id: CATEGORY }]);
    }
    if (/\/submissions$/.test(url.pathname)) {
        return send([{ user_id: STUDENT, workflow_state: 'graded', submitted_at: '2026-01-15', score: 9, entered_score: 9 }]);
    }

    return send([]);
});

test('the anonymous self signup endpoint', async (t) => {
    for (const suffix of ['', '-shm', '-wal']) {
        try { fs.unlinkSync(DB + suffix); } catch { /* not there */ }
    }

    await new Promise((r) => canvasServer.listen(0, r));
    const canvasBase = `http://127.0.0.1:${canvasServer.address().port}`;
    const port = 4500 + (process.pid % 90);

    Object.assign(process.env, {
        DB_PATH: DB,
        PORT: String(port),
        NODE_ENV: 'test',
        SESSION_SECRET: 'test-secret',
        ltiConsumerKeys: 'canvas:s3cret',
        WEBSITE_HOSTNAME: 'localhost',
        systemApiToken: 'system-token',
        /* The setting under test. canvasBaseUri is deliberately NOT set, which is what
           exposed the missing domain in the first place. */
        selfSignupApiDomain: canvasBase
    });
    delete process.env.canvasBaseUri;

    const { server } = require(path.join(ROOT, 'app.js'));
    const db = require(path.join(ROOT, 'db'));
    await new Promise((r) => setTimeout(r, 600));

    t.after(async () => {
        server.close();
        canvasServer.close();
        await db.close();
    });

    /* A teacher configured a rule for each course. */
    await db.setSelfSignupConfig(COURSE, CATEGORY, ASSIGNMENT, 'Pass the quiz first.', 5);
    await db.setSelfSignupConfig(OTHER_COURSE, OTHER_CATEGORY, OTHER_ASSIGNMENT, 'Other rule.', 5);

    const call = (course, user) => fetch(`http://127.0.0.1:${port}/api/self-signup/${course}/${user}`).then((r) => r.json());

    await t.test('answers with no session and no cookie at all', async () => {
        apiCalls = [];
        const body = await call(COURSE, STUDENT);

        assert.equal(body.success, true, JSON.stringify(body));
        assert.equal(body.groups.length, 1, JSON.stringify(body));
        assert.equal(body.groups[0].passed, true, 'scored 9 against a minimum of 5');
        assert.equal(body.groups[0].description, 'Pass the quiz first.');
    });

    await t.test('the configured domain is the one actually called', async () => {
        assert.ok(apiCalls.some((p) => p.includes(`/group_categories/${CATEGORY}/groups`)),
            `expected a call to the stub, got: ${apiCalls.join(', ')}`);
    });

    await t.test('the submission is not leaked back to the caller', async () => {
        const body = await call(COURSE, STUDENT);

        assert.ok(!('debug' in body.groups[0]), JSON.stringify(body.groups[0]));
        assert.ok(!JSON.stringify(body).includes('entered_score'));
    });

    await t.test('a student below the minimum does not pass', async () => {
        const body = await call(COURSE, 9999);

        assert.equal(body.groups[0].passed, false, 'no submission for that user at all');
    });

    await t.test('with no domain configured it fails as a handled error, not a crash', async () => {
        delete process.env.selfSignupApiDomain;

        try {
            const body = await call(OTHER_COURSE, STUDENT);

            /* The route catches, logs and answers; it must not throw out of the handler. */
            assert.deepEqual(body, { success: false, groups: [] }, JSON.stringify(body));
        }
        finally {
            process.env.selfSignupApiDomain = canvasBase;
        }
    });

    await t.test('a course with no rule configured answers with nothing to block', async () => {
        const body = await call(99999, STUDENT);

        assert.deepEqual(body, { success: true, groups: [] });
    });
});
