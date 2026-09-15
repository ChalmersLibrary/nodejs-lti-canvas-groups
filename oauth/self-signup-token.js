/*
 * The access token the anonymous self signup endpoint calls Canvas with.
 *
 * Every other route acts as the user who launched, with a token obtained and refreshed per user.
 * This endpoint has no launch and no user, so it needs a credential of its own. A token generated
 * in someone's Canvas profile carries that person's whole authority; a token issued through a
 * developer key with enforce scopes on is limited to the urls the key lists, which for this
 * endpoint is two read-only ones. That is the reason for the extra machinery here.
 *
 * Canvas does not rotate refresh tokens, so the refresh token is configuration and is never
 * written back. Only the access token is state, it lasts an hour, and it is kept in memory: the
 * process holds it, a restart fetches a new one, and nothing is persisted.
 */
'use strict';

require('dotenv').config({ quiet: true });

const axios = require('axios');
const canvas = require('../canvas');
const log = require('../log');

/* Refresh slightly early, so a token cannot expire between the check and the call using it. */
const EXPIRY_SKEW_MS = 60 * 1000;

let cached = null;
let refreshing = null;

const clientId = () => process.env.selfSignupOauthClientId;
const clientSecret = () => process.env.selfSignupOauthClientSecret;
const refreshToken = () => process.env.selfSignupRefreshToken;

/**
 * Whether the scoped credential is configured at all. When it is not, the endpoint falls back to
 * systemApiToken, which is what installations that have not done the developer key bootstrap use.
 */
exports.isConfigured = () => Boolean(clientId() && clientSecret() && refreshToken());

const requestAccessToken = async (request) => {
    const tokenUri = canvas.providerBaseUri(request) + '/login/oauth2/token';

    let response;

    try {
        response = await axios.post(tokenUri, {
            grant_type: 'refresh_token',
            client_id: clientId(),
            client_secret: clientSecret(),
            refresh_token: refreshToken()
        });
    }
    catch (error) {
        /* A refused refresh means the grant is gone: the approval was removed in Canvas, the key
           was deleted or turned off, or the token was revoked. Retrying cannot help, and only a
           new authorization brings it back, so say that rather than logging a bare error. */
        if (error.response?.status === 400) {
            throw new Error('Canvas refused the refresh with 400, so the grant is gone. Retrying ' +
                'will not help: the developer key authorization has to be run again and ' +
                'selfSignupRefreshToken replaced.', { cause: error });
        }

        throw error;
    }

    /* An answer without a token would otherwise become an undefined bearer on the api calls, and
       fail there rather than here, where the cause is. */
    if (!response.data?.access_token || !response.data?.expires_in) {
        throw new Error('Canvas answered the refresh without an access token and an expiry, so ' +
            'there is nothing to call the api with.');
    }

    /* expires_in is seconds. Canvas returns no new refresh token here, by design, which is why
       nothing is written back. */
    cached = {
        accessToken: response.data.access_token,
        expiresAt: Date.now() + (response.data.expires_in * 1000)
    };

    log.info('[SelfSignupToken] Refreshed the scoped access token, valid for ' +
        `${response.data.expires_in} seconds.`);

    return cached.accessToken;
};

/**
 * A valid access token, refreshing when the cached one is spent. Returns null when the scoped
 * credential is not configured, which is the caller's signal to fall back.
 *
 * The request carries the Canvas domain, the same stand-in session the endpoint builds for its
 * api calls, since this runs with no launch behind it.
 */
exports.accessToken = async (request) => {
    if (!exports.isConfigured()) {
        return null;
    }

    if (cached && cached.expiresAt - Date.now() > EXPIRY_SKEW_MS) {
        return cached.accessToken;
    }

    /* This endpoint is anonymous and every student on a group page calls it, so an expiry at a
       busy moment would otherwise send one refresh per request. Everyone waits on the first. */
    if (!refreshing) {
        refreshing = requestAccessToken(request).finally(() => { refreshing = null; });
    }

    return refreshing;
};

/**
 * A replacement for an access token Canvas has just rejected.
 *
 * A grant holds one access token, and a refresh regenerates it: anything else configured with
 * this same credential refreshing leaves the token held here a string Canvas no longer knows,
 * most of its hour still to run. A rejection therefore does not mean the credential is broken,
 * and one refresh puts it right.
 *
 * When the cache holds something other than the rejected token, another caller has already
 * replaced it, so that one is handed out instead and a burst of rejections costs one exchange
 * rather than one each.
 */
exports.accessTokenAfterRejection = async (request, rejectedToken) => {
    if (!exports.isConfigured()) {
        return null;
    }

    if (cached && cached.accessToken !== rejectedToken) {
        return cached.accessToken;
    }

    cached = null;

    return exports.accessToken(request);
};

/* Tests run several cases in one process, and the cache would carry between them. */
exports.forget = () => { cached = null; refreshing = null; };
