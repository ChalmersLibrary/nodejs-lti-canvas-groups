/*
 * The scoped credential the anonymous self signup endpoint uses.
 *
 * What matters here is not that a refresh works but what happens around it: that a busy moment
 * sends one refresh rather than one per caller, that a spent token is replaced, and that a grant
 * Canvas has refused says so rather than failing as a generic error.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

let refreshCalls = [];
let nextStatus = 200;
let nextExpiresIn = 3600;
let issued = 0;

const canvasServer = http.createServer((req, res) => {
    let body = '';

    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
        refreshCalls.push(JSON.parse(body));

        if (nextStatus !== 200) {
            res.writeHead(nextStatus, { 'content-type': 'application/json' });

            return res.end(JSON.stringify({ error: 'invalid_grant' }));
        }

        issued += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: `scoped-token-${issued}`, expires_in: nextExpiresIn }));
    });
});

test('the scoped self signup credential', async (t) => {
    await new Promise((r) => canvasServer.listen(0, r));
    const canvasBase = `http://127.0.0.1:${canvasServer.address().port}`;

    Object.assign(process.env, {
        NODE_ENV: 'test',
        selfSignupOauthClientId: '10000002',
        selfSignupOauthClientSecret: 'scoped-secret',
        selfSignupRefreshToken: 'scoped-refresh',
        /* Empty rather than deleted: dotenv fills in absent keys at require time and would
           otherwise hand these tests the developer's own Canvas. */
        canvasBaseUri: ''
    });

    const token = require(path.join(ROOT, 'oauth', 'self-signup-token'));
    const request = { session: { canvasApiDomain: canvasBase } };

    t.after(() => canvasServer.close());

    /* Including the issued counter: the token names are asserted, so they have to start from the
       same place in every case rather than carrying over from the one before. */
    const reset = () => {
        token.forget();
        refreshCalls = [];
        nextStatus = 200;
        nextExpiresIn = 3600;
        issued = 0;
    };

    await t.test('it is configured only when all three settings are present', () => {
        assert.equal(token.isConfigured(), true);

        const saved = process.env.selfSignupRefreshToken;
        process.env.selfSignupRefreshToken = '';

        try {
            assert.equal(token.isConfigured(), false, 'a missing refresh token means not configured');
        }
        finally {
            process.env.selfSignupRefreshToken = saved;
        }
    });

    await t.test('the refresh sends the grant Canvas expects', async () => {
        reset();

        const value = await token.accessToken(request);

        assert.equal(value, 'scoped-token-1');
        assert.equal(refreshCalls.length, 1);
        assert.deepEqual(refreshCalls[0], {
            grant_type: 'refresh_token',
            client_id: '10000002',
            client_secret: 'scoped-secret',
            refresh_token: 'scoped-refresh'
        });
    });

    await t.test('a second call inside the hour does not refresh again', async () => {
        reset();

        await token.accessToken(request);
        const second = await token.accessToken(request);

        assert.equal(second, 'scoped-token-1');
        assert.equal(refreshCalls.length, 1, 'the cached token should have been used');
    });

    await t.test('twenty simultaneous callers cause one refresh, not twenty', async () => {
        reset();

        const values = await Promise.all(Array.from({ length: 20 }, () => token.accessToken(request)));

        assert.equal(refreshCalls.length, 1, `expected one refresh, got ${refreshCalls.length}`);
        assert.ok(values.every((v) => v === values[0]), 'every caller should get the same token');
    });

    await t.test('a token near its expiry is replaced rather than handed out', async () => {
        reset();
        /* Inside the skew the module refreshes early, so this token is already spent. */
        nextExpiresIn = 30;

        const first = await token.accessToken(request);
        const second = await token.accessToken(request);

        assert.equal(first, 'scoped-token-1');
        assert.equal(second, 'scoped-token-2', 'the spent token should not be reused');
        assert.equal(refreshCalls.length, 2);
    });

    await t.test('a refused refresh says the grant is gone, not just that a request failed', async () => {
        reset();
        nextStatus = 400;

        await assert.rejects(() => token.accessToken(request), (error) => {
            assert.match(error.message, /grant is gone/);
            assert.match(error.message, /selfSignupRefreshToken/, 'it should name what to replace');

            return true;
        });
    });

    await t.test('a failed refresh is not cached, so the next call tries again', async () => {
        reset();
        nextStatus = 400;

        await assert.rejects(() => token.accessToken(request));

        nextStatus = 200;
        const recovered = await token.accessToken(request);

        assert.equal(recovered, 'scoped-token-1', 'it should recover once Canvas answers again');
    });

    await t.test('with nothing configured it returns null, which is the signal to fall back', async () => {
        reset();

        const saved = process.env.selfSignupOauthClientId;
        process.env.selfSignupOauthClientId = '';

        try {
            assert.equal(await token.accessToken(request), null);
            assert.equal(refreshCalls.length, 0, 'it must not call Canvas when unconfigured');
        }
        finally {
            process.env.selfSignupOauthClientId = saved;
        }
    });
});
