'use strict';

require('dotenv').config({ quiet: true });
const axios = require('axios');
const canvas = require('../canvas');
const log = require('../log');
const db = require('../db');

const clientRedirectUri = (process.env.WEBSITE_HOSTNAME == "localhost" ? "http://localhost:3000" : "https://" + process.env.WEBSITE_HOSTNAME) + "/oauth/redirect";
const clientId = process.env.oauthClientId ? process.env.oauthClientId : "";
const clientSecret = process.env.oauthClientSecret ? process.env.oauthClientSecret : "";
const clientState = process.env.oauthClientState ? process.env.oauthClientState : (process.env.COMPUTERNAME ? process.env.COMPUTERNAME : "C2D7938F027A5FD7A7076CA7");
const providerLoginUri = "/login/oauth2/auth?client_id=" + clientId + "&response_type=code&state=" + clientState + "&redirect_uri=" + clientRedirectUri;

if (process.env.NODE_ENV == "development") {
    log.info("[OAuth] clientRedirectUri " + clientRedirectUri);
    log.info("[OAuth] clientId " + clientId);
    log.info("[OAuth] clientState " + clientState);
    log.info("[OAuth] providerLoginUri " + providerLoginUri);
}

/**
 * Returns the correct OAuth login uri.
 */
exports.providerLogin = (request) => {
    if (!providerLoginUri || !request) {
        throw new Error("Can't construct URI for OAuth provider login.");
    }

    const baseUri = canvas.providerBaseUri(request);

    /* providerBaseUri answers '//' when it has neither the canvasBaseUri setting nor an api
       domain from the launch in the session. Concatenating that produces '///login/oauth2/...',
       which is a redirect to nowhere and looks like a Canvas problem rather than a missing
       session, so say what is actually wrong instead. */
    if (baseUri === '//') {
        throw new Error("No Canvas api domain: the session has no custom_canvas_api_domain from " +
            "the LTI launch and canvasBaseUri is not set. If the launch did arrive, the session " +
            "cookie is not coming back, which is what happens when it is rejected by the browser.");
    }

    const thisProviderLoginUri = baseUri + providerLoginUri;

    log.info("[OAuth] Redirecting to OAuth URI: " + thisProviderLoginUri);

    return thisProviderLoginUri;
};

/**
 * Exchanges the code that Canvas sends back to the redirect uri for a token, stores it in
 * the database and returns it for the session.
 */
exports.providerRequestToken = async (request) => {
    const requestCode = request.query.code;
    const requestState = request.query.state;
    const requestError = request.query.error;

    log.info("[OAuth] Request token for state: '" + requestState + "', error: '" + requestError + "'");

    if (requestError == 'access_denied') {
        throw new Error("Access Denied from OAuth in Canvas.");
    }

    if (!requestCode) {
        throw new Error("Unknown error from OAuth in Canvas.");
    }

    log.info("[OAuth] Session id " + request.session.id + ", user_id '" + request.session.userId + "', course id " + request.session.canvasCourseId + ".");

    if (!request.session.userId || !request.session.canvasCourseId) {
        throw new Error("Session is not valid; third-party cookies must be allowed.");
    }

    if (requestState != clientState) {
        throw new Error("Not a valid request, state is not correct.");
    }

    const tokenUri = canvas.providerBaseUri(request) + "/login/oauth2/token";

    log.info("[OAuth] POST to get OAuth Token (" + tokenUri + ")");

    let response;

    try {
        response = await axios.post(tokenUri, {
            grant_type: "authorization_code",
            client_id: clientId,
            client_secret: clientSecret,
            code: requestCode
        });
    }
    catch (error) {
        throw new Error("HTTP error: " + error, { cause: error });
    }

    const tokenData = {
        access_token: response.data.access_token,
        token_type: response.data.token_type,
        refresh_token: response.data.refresh_token,
        expires_in: response.data.expires_in,
        expires_at_utc: new Date(Date.now() + (response.data.expires_in * 1000))
    };

    log.info("[OAuth] Got token data for user_id " + request.session.userId + ", expires: " + tokenData.expires_at_utc);

    await db.setClientData(
        request.session.userId,
        canvas.providerEnvironment(request),
        tokenData.access_token,
        tokenData.refresh_token,
        tokenData.expires_at_utc
    );

    return tokenData;
};

/**
 * Refreshes the access token with the refresh token in the session.
 *
 * The new token goes into the database before the session, since the database is the source
 * of truth for it; a session write can be lost when several requests write the session at
 * the same time, and the canvas module reads the database back when that has happened.
 */
exports.providerRefreshToken = async (request) => {
    if (!request.session?.token?.refresh_token) {
        throw new Error("No refresh token in session, reauthorization is needed.");
    }

    if (!request.session.userId || !request.session.canvasCourseId) {
        throw new Error("Session is not valid; third-party cookies must be allowed.");
    }

    const tokenUri = canvas.providerBaseUri(request) + "/login/oauth2/token";

    log.info("[OAuth] Refresh token for client_id: " + clientId);
    log.info("[OAuth] Api path: " + tokenUri);

    let response;

    try {
        response = await axios.post(tokenUri, {
            grant_type: "refresh_token",
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: request.session.token.refresh_token
        });
    }
    catch (error) {
        log.error("[OAuth] Refreshing existing token: " + error);

        throw error;
    }

    const refreshedToken = {
        ...request.session.token,
        access_token: response.data.access_token,
        expires_in: response.data.expires_in,
        expires_at_utc: new Date(Date.now() + (response.data.expires_in * 1000))
    };

    try {
        await db.setClientData(
            request.session.userId,
            canvas.providerEnvironment(request),
            refreshedToken.access_token,
            refreshedToken.refresh_token,
            refreshedToken.expires_at_utc
        );
    }
    catch (error) {
        log.error("[OAuth] Error during token database store: " + error);

        throw error;
    }

    request.session.token = refreshedToken;

    log.info("[OAuth] Refreshed token for user_id " + request.session.userId + ", expires: " + refreshedToken.expires_at_utc);

    return refreshedToken;
};

/**
 * Asks Canvas to forget the approved access token for the user in the session.
 */
exports.providerDeleteToken = async (request) => {
    if (!request.session?.userId) {
        throw new Error("Session is not valid; no user to delete the token for.");
    }

    log.info("[Token delete] Deleting approved access token in Canvas for user_id " + request.session.userId);

    try {
        const response = await axios.delete(canvas.providerBaseUri(request) + "/login/oauth2/token");

        log.info("[Token delete] Canvas answered " + response.status + ".");

        return response;
    }
    catch (error) {
        log.error("[Token delete] Deleting approved access token: " + error);

        throw error;
    }
};
