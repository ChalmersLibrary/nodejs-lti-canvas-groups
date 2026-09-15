/*
 * The OAuth login uri is built from the Canvas api domain, which normally comes from the LTI
 * launch and lives in the session. When it is missing, providerBaseUri answers '//' and
 * concatenating that used to produce '///login/oauth2/auth?...', a redirect to nowhere that
 * reads like a Canvas fault rather than a session that was never stored.
 *
 * The redirect uri in it comes from the host the request arrived on, so that a tool answering
 * on several hostnames sends the user back to the one they launched from. WEBSITE_HOSTNAME is
 * the fallback for a call with no usable host.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const tmpDb = require('./helpers/tmpdb');

const ROOT = path.join(__dirname, '..');

process.env.DB_PATH = tmpDb('oauth-login-uri-db.sqlite3');
process.env.oauthClientId = '10000001';
process.env.oauthClientState = 'teststate';
process.env.WEBSITE_HOSTNAME = 'localhost';

/* Empty rather than deleted. The modules under test call dotenv at require time, which is
   after this line, and dotenv fills in any key that is absent from process.env -- so a
   developer with canvasBaseUri in their own .env got it back and this file tested their
   configuration instead of the one it sets up. An empty value is present, so dotenv leaves
   it alone, and it is falsy, so the code reads it as unset. */
process.env.canvasBaseUri = '';

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
        process.env.canvasBaseUri = '';
    }
});

test('no request at all is still refused', () => {
    assert.throws(() => oauth.providerLogin(), /Can't construct URI/);
});

/* A request as express presents it: the launch host and the scheme it arrived over. */
const requestOn = (host, protocol = 'https') => ({
    protocol,
    get: (name) => (name.toLowerCase() === 'host' ? host : undefined),
    session: { canvasApiDomain: 'chalmers.instructure.com' }
});

test('the redirect uri follows the host the request arrived on', () => {
    const uri = oauth.providerLogin(requestOn('groups.lti.chalmers.se'));

    assert.match(uri, /redirect_uri=https:\/\/groups\.lti\.chalmers\.se\/oauth\/redirect/);
});

test('the old hostname still completes on the old hostname, which is what removes the flag day', () => {
    const uri = oauth.providerLogin(requestOn('canvas-cth-lti-group-tool.azurewebsites.net'));

    assert.match(uri, /redirect_uri=https:\/\/canvas-cth-lti-group-tool\.azurewebsites\.net\/oauth\/redirect/);
});

test('the scheme comes from the request, so a tunnel over http is not rewritten to https', () => {
    const uri = oauth.providerLogin(requestOn('localhost:3000', 'http'));

    assert.match(uri, /redirect_uri=http:\/\/localhost:3000\/oauth\/redirect/);
});

test('a host that is not a hostname falls back rather than being pasted into the query string', () => {
    /* The host arrives in a header. Interpolating this one would add a parameter of the
       caller's choosing to the uri Canvas sends the user back through. */
    const uri = oauth.providerLogin(requestOn('evil.example&client_id=999'));

    assert.match(uri, /redirect_uri=http:\/\/localhost:3000\/oauth\/redirect/);
    assert.doesNotMatch(uri, /evil\.example/);
    assert.doesNotMatch(uri, /client_id=999/);
});
