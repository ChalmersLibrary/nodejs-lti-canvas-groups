/*
 * The Zoom export writes the address Zoom will recognise, which is derived from the login
 * rather than taken from Canvas. A student can set their primary email in Canvas to anything,
 * and the old export then wrote that address into the pre-assignment, where it matched nothing.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { signedLaunch, Jar } = require('./helpers/lti');

const ROOT = path.join(__dirname, '..');
const DB = path.join(__dirname, 'csv-export-db.sqlite3');
const SECRET = 's3cret';

/* One group with five users, each a case the mapping has to get right. */
const USERS = [
    /* keeps the school address it already had */
    { id: 1, name: 'Anna Andersson', sortable_name: 'Andersson, Anna', email: 'anna@student.school.se', login_id: 'anna@student.school.se' },
    /* changed their primary email in Canvas to a private one */
    { id: 2, name: 'Bo Bengtsson', sortable_name: 'Bengtsson, Bo', email: 'bo.bengtsson@gmail.com', login_id: 'bosse@student.school.se' },
    /* login id is a bare account name rather than an address */
    { id: 3, name: 'Cecilia Carlsson', sortable_name: 'Carlsson, Cecilia', email: 'cissi@example.org', login_id: 'ceci' },
    /* Canvas reported no login id, so the primary email is all there is */
    { id: 4, name: 'David Davidsson', sortable_name: 'Davidsson, David', email: 'david@student.school.se' },
    /* a teacher, whose login is on the staff domain rather than the student one */
    { id: 5, name: 'Eva Eriksson', sortable_name: 'Eriksson, Eva', email: 'eva.private@gmail.com', login_id: 'evaeri@school.se' }
];

const canvasServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (body) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
    };

    if (url.pathname === '/login/oauth2/token') {
        return send({ access_token: 'tok', token_type: 'Bearer', refresh_token: 'ref', expires_in: 3600 });
    }
    if (/group_categories\/901\/groups$/.test(url.pathname)) {
        return send([{ id: 11, name: 'Lab 1', group_category_id: 901 }]);
    }
    if (/groups\/11\/users$/.test(url.pathname)) {
        return send(USERS);
    }

    return send([]);
});

test('the Zoom export writes addresses Zoom can match', async (t) => {
    for (const suffix of ['', '-shm', '-wal']) {
        try { fs.unlinkSync(DB + suffix); } catch { /* not there */ }
    }

    await new Promise((r) => canvasServer.listen(0, r));
    const canvasBase = `http://127.0.0.1:${canvasServer.address().port}`;
    const port = 4300 + (process.pid % 90);

    Object.assign(process.env, {
        DB_PATH: DB,
        PORT: String(port),
        NODE_ENV: 'test',
        trustProxy: 'true',
        canvasBaseUri: canvasBase,
        ltiConsumerKeys: `canvas:${SECRET}`,
        SESSION_SECRET: 'test-secret',
        WEBSITE_HOSTNAME: 'localhost',
        oauthClientState: 'teststate',
        oauthClientId: '10000001',
        oauthClientSecret: 'oauth-secret',
        /* The setting under test. Read per request, so a case below can unset it. */
        zoomEmailDomain: 'student.school.se'
    });

    const { server } = require(path.join(ROOT, 'app.js'));
    await new Promise((r) => setTimeout(r, 600));

    t.after(async () => {
        server.close();
        canvasServer.close();
        await require(path.join(ROOT, 'db')).close();
    });

    /* Launch, so there is a session with a token to call Canvas with. */
    const jar = new Jar();
    const body = signedLaunch(`https://127.0.0.1:${port}/launch_lti`, SECRET, { oauth_consumer_key: 'canvas' });
    const launch = await fetch(`http://127.0.0.1:${port}/launch_lti`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-proto': 'https' },
        body: new URLSearchParams(body).toString()
    });
    jar.store(launch);

    const oauth = await fetch(`http://127.0.0.1:${port}/oauth/redirect?code=c&state=teststate`, {
        redirect: 'manual',
        headers: { cookie: jar.header(), 'x-forwarded-proto': 'https' }
    });
    jar.store(oauth);

    const csvRows = async (flavour) => {
        const response = await fetch(`http://127.0.0.1:${port}/csv/${flavour}category/901/Labs`, {
            headers: { cookie: jar.header(), 'x-forwarded-proto': 'https' }
        });

        assert.equal(response.status, 200, `${flavour || 'groups'} export should have been produced`);

        const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(new Uint8Array(await response.arrayBuffer()));

        return text.trim().split('\r\n');
    };

    await t.test('a school address is kept as it is', async () => {
        const rows = await csvRows('zoom/');

        assert.equal(rows[1], 'Lab 1,anna@student.school.se');
    });

    await t.test('a private primary email is replaced by the login at the school domain', async () => {
        const rows = await csvRows('zoom/');

        assert.equal(rows[2], 'Lab 1,bosse@student.school.se', 'the gmail address must not reach the export');
        assert.ok(!rows.join('\n').includes('gmail.com'), 'no private address anywhere in the file');
    });

    await t.test('a bare login name gets the configured domain', async () => {
        const rows = await csvRows('zoom/');

        assert.equal(rows[3], 'Lab 1,ceci@student.school.se');
    });

    await t.test('a login on another domain keeps that domain', async () => {
        /* Teachers and students have different domains, and the login says which. Nothing
           here has to know who teaches. */
        const rows = await csvRows('zoom/');

        assert.equal(rows[5], 'Lab 1,evaeri@school.se',
            'the staff domain must not be rewritten to the student one');
    });

    await t.test('no login id falls back to the primary email', async () => {
        const rows = await csvRows('zoom/');

        assert.equal(rows[4], 'Lab 1,david@student.school.se');
    });

    await t.test('the Excel export still reports the email the student chose', async () => {
        /* That export is read by a human who may want to write to the student. */
        const rows = await csvRows('');

        assert.match(rows[0], /Group;Student;Email address/);
        assert.ok(rows.join('\n').includes('"bo.bengtsson@gmail.com"'), 'the chosen address belongs here');
    });

    await t.test('without zoomEmailDomain the login id is written unchanged', async () => {
        delete process.env.zoomEmailDomain;

        try {
            const rows = await csvRows('zoom/');

            assert.equal(rows[1], 'Lab 1,anna@student.school.se');
            assert.equal(rows[2], 'Lab 1,bosse@student.school.se', 'still the login id, not the gmail address');
            assert.equal(rows[3], 'Lab 1,ceci', 'a bare login name cannot be turned into an address');
            assert.equal(rows[4], 'Lab 1,david@student.school.se', 'no login id, so the email');
            assert.equal(rows[5], 'Lab 1,evaeri@school.se', 'a login with a domain never needed the setting');
        }
        finally {
            process.env.zoomEmailDomain = 'student.school.se';
        }
    });
});
