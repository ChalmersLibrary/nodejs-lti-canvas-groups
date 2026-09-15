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
const http = require('node:http');
const path = require('node:path');
const tmpDb = require('./helpers/tmpdb');

const ROOT = path.join(__dirname, '..');
const DB = tmpDb('self-signup-api-db.sqlite3');

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
        selfSignupApiDomain: canvasBase,
        /* Empty, not absent: this file is about the systemApiToken path, and a developer whose
           own .env holds a scoped credential would otherwise have dotenv hand it over and send
           the refresh at the stub below. The scoped path has its own file. */
        selfSignupOauthClientId: '',
        selfSignupOauthClientSecret: '',
        selfSignupRefreshToken: ''
    });

    /* Empty rather than deleted. app.js calls dotenv at require time, which is after this line,
       and dotenv fills in any key that is absent from process.env -- so a developer with
       canvasBaseUri in their own .env got it back, and since it wins over the domain on the
       session, the endpoint called that host instead of the stub below. An empty value is
       present, so dotenv leaves it alone, and it is falsy, so the code reads it as unset. */
    process.env.canvasBaseUri = '';

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

    const fetchCall = (course, user) => fetch(`http://127.0.0.1:${port}/api/self-signup/${course}/${user}`);
    const call = (course, user) => fetchCall(course, user).then((r) => r.json());

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
            const response = await fetchCall(OTHER_COURSE, STUDENT);
            const body = await response.json();

            /* The route catches, logs and answers; it must not throw out of the handler. */
            assert.deepEqual(body, { success: false, groups: [] }, JSON.stringify(body));

            /* And it says so in the status, which is the only part a monitor can read. The body
               stays as it was so that the consumer behaves identically. */
            assert.equal(response.status, 503, 'a failure must not be served as 200');
        }
        finally {
            process.env.selfSignupApiDomain = canvasBase;
        }
    });

    await t.test('an answer with nothing to block is still a 200, not a failure', async () => {
        /* The distinction a monitor needs: no rule configured is a correct answer, and only the
           error path is a 5xx. Conflating them would make every unconfigured course an alert. */
        const response = await fetchCall(99999, STUDENT);

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { success: true, groups: [] });
    });

    await t.test('a course with no rule configured answers with nothing to block', async () => {
        const body = await call(99999, STUDENT);

        assert.deepEqual(body, { success: true, groups: [] });
    });

    await t.test('and asks Canvas nothing at all, not even for a token', async () => {
        /* A course with no rule has nothing to look up, so it must answer without a credential.
           Acquiring the token before checking cost a refresh on every course that has no rule,
           and turned a broken credential into a failure for courses that did not need one. The
           stub has no token endpoint, so a refresh attempt both shows up in apiCalls and fails,
           which is what makes this case tell the two versions apart. */
        apiCalls = [];
        const saved = {
            systemApiToken: process.env.systemApiToken,
            clientId: process.env.selfSignupOauthClientId
        };

        Object.assign(process.env, {
            systemApiToken: '',
            selfSignupOauthClientId: '10000002',
            selfSignupOauthClientSecret: 'scoped-secret',
            selfSignupRefreshToken: 'scoped-refresh'
        });

        try {
            const body = await call(99999, STUDENT);

            assert.deepEqual(body, { success: true, groups: [] }, JSON.stringify(body));
            assert.equal(apiCalls.length, 0, `expected no call to Canvas, got: ${apiCalls.join(', ')}`);
        }
        finally {
            Object.assign(process.env, {
                systemApiToken: saved.systemApiToken,
                selfSignupOauthClientId: saved.clientId,
                selfSignupOauthClientSecret: '',
                selfSignupRefreshToken: ''
            });
        }
    });
});
