/*
 * The OAuth login uri is built from the Canvas api domain, which normally comes from the LTI
 * launch and lives in the session. When it is missing, providerBaseUri answers '//' and
 * concatenating that used to produce '///login/oauth2/auth?...', a redirect to nowhere that
 * reads like a Canvas fault rather than a session that was never stored.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

process.env.DB_PATH = path.join(__dirname, 'oauth-login-uri-db.sqlite3');
process.env.oauthClientId = '10000001';
process.env.oauthClientState = 'teststate';
process.env.WEBSITE_HOSTNAME = 'localhost';
delete process.env.canvasBaseUri;

const oauth = require(path.join(ROOT, 'oauth'));
const db = require(path.join(ROOT, 'db'));

test.after(() => db.close());

test('the api domain from the launch is used', () => {
    const uri = oauth.providerLogin({ session: { canvasApiDomain: 'chalmers.instructure.com' } });

    assert.match(uri, /^https:\/\/chalmers\.instructure\.com\/login\/oauth2\/auth\?/);
    assert.match(uri, /client_id=10000001/);
    assert.match(uri, /redirect_uri=http:\/\/localhost:3000\/oauth\/redirect/);
});

test('no api domain and no canvasBaseUri says what is wrong, rather than redirecting to ///', () => {
    assert.throws(
        () => oauth.providerLogin({ session: {} }),
        (error) => {
            assert.match(error.message, /No Canvas api domain/);
            assert.match(error.message, /custom_canvas_api_domain/);
            /* The old behaviour: a uri starting with three slashes. */
            assert.doesNotMatch(error.message, /^\/\/\//);

            return true;
        }
    );
});

test('canvasBaseUri overrides the launch, for local development', () => {
    process.env.canvasBaseUri = 'https://chalmers.test.instructure.com';

    try {
        const uri = oauth.providerLogin({ session: { canvasApiDomain: 'chalmers.instructure.com' } });

        assert.match(uri, /^https:\/\/chalmers\.test\.instructure\.com\/login\/oauth2\/auth\?/);
    }
    finally {
        delete process.env.canvasBaseUri;
    }
});

test('no request at all is still refused', () => {
    assert.throws(() => oauth.providerLogin(), /Can't construct URI/);
});
