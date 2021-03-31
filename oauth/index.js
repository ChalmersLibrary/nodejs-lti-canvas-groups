'use strict';

const axios = require('axios');
const canvas = require('../canvas');
const log = require('../log');
const db = require('../db');

const clientRedirectUri = "https://" + process.env.WEBSITE_HOSTNAME + "/oauth/redirect";
const clientId = process.env.oauthClientId ? process.env.oauthClientId : "";
const clientSecret = process.env.oauthClientSecret ? process.env.oauthClientSecret : "";
const clientState = process.env.oauthClientState ? process.env.oauthClientState : (process.env.COMPUTERNAME ? process.env.COMPUTERNAME : "C2D7938F027A5FD7A7076CA7");
const providerLoginUri = "/login/oauth2/auth?client_id=" + clientId + "&response_type=code&state=" + clientState + "&redirect_uri=" + clientRedirectUri;


/**
 * Returns the correct OAuth login uri. 
 */
exports.providerLogin = (request) => {
    if (providerLoginUri && request) {
        const thisProviderLoginUri = canvas.providerBaseUri(request) + providerLoginUri;
        log.info("[OAuth] Redirecting to OAuth URI: " + thisProviderLoginUri);

        return thisProviderLoginUri;
    } else {
        throw (new Error("Can't construct URI for OAuth provider login."));
    }
};

/**
 * Requests a token from OAuth service.
 */
exports.providerRequestToken = async(request) => new Promise(function(resolve, reject) {
    const requestCode = request.query.code;
    const requestState = request.query.state;
    const requestError = request.query.error;

    log.info("[OAuth] Request token: '" + requestCode + "', state: '" + requestState + "', error: '" + requestError + "'");

    if (requestCode !== 'undefined') {
        if (request.session.userId && request.session.canvasCourseId) {
            if (requestState == clientState) {
                log.info("[OAuth] POST to get OAuth Token (" + canvas.providerBaseUri(request) + "/login/oauth2/token)");

                axios({
                        method: 'post',
                        url: canvas.providerBaseUri(request) + "/login/oauth2/token",
                        data: {
                            grant_type: "authorization_code",
                            client_id: clientId,
                            client_secret: clientSecret,
                            code: requestCode
                        }
                    })
                    .then(async(response) => {
                        log.info("[OAuth] Response: " + JSON.stringify(response.data));

                        const tokenData = {
                            access_token: response.data.access_token,
                            token_type: response.data.token_type,
                            refresh_token: response.data.refresh_token,
                            expires_in: response.data.expires_in,
                            expires_at_utc: new Date(Date.now() + (response.data.expires_in * 1000))
                        };

                        log.info("[OAuth] Got token data: " + JSON.stringify(tokenData));

                        db.setClientData(
                                request.session.userId,
                                canvas.providerEnvironment(request),
                                tokenData.access_token,
                                tokenData.refresh_token,
                                tokenData.expires_at_utc)
                            .then(() => {
                                resolve(tokenData);
                            })
                            .catch((error) => {
                                reject(error);
                            })
                    })
                    .catch((error) => {
                        reject(new Error("HTTP error: " + error));
                    });
            } else {
                reject(new Error("Not a valid request, state is not correct."));
            }
        } else {
            reject(new Error("Session is not valid; third-party cookies must be allowed."));
        }
    } else if (requestError == 'access_denied') {
        reject(new Error("Access Denied from OAuth in Canvas."));
    } else {
        reject(new Error("Unknown error from OAuth in Canvas."));
    }
});

/**
 * Refreshes a token from OAuth server.
 */
exports.providerRefreshToken = async(request) => new Promise(function(resolve, reject) {
    if (request.session.userId && request.session.canvasCourseId) {
        log.info("[OAuth] Refresh token data: client_id: " + clientId + "client_secret: " + clientSecret + "refresh_token: " + request.session.token.refresh_token);
        log.info("[OAuth] Api path: " + canvas.providerBaseUri(request) + "/login/oauth2/token");

        axios({
                method: "post",
                url: canvas.providerBaseUri(request) + "/login/oauth2/token",
                data: {
                    grant_type: "refresh_token",
                    client_id: clientId,
                    client_secret: clientSecret,
                    refresh_token: request.session.token.refresh_token
                }
            })
            .then((response) => {
                request.session.token.access_token = response.data.access_token;
                request.session.token.expires_in = response.data.expires_in;
                request.session.token.expires_at_utc = new Date(Date.now() + (response.data.expires_in * 1000));

                db.setClientData(
                        request.session.userId,
                        canvas.providerEnvironment(request),
                        request.session.token.access_token,
                        request.session.token.refresh_token,
                        request.session.token.expires_at_utc
                    )
                    .then(() => {
                        log.info("[OAuth] Refreshed token: " + JSON.stringify(request.session.token) + ", expires: " + request.session.token.expires_at_utc);
                        resolve();
                    })
                    .catch((error) => {
                        log.error("[OAuth] Error during token database store: " + error);
                        reject(error);
                    })
            })
            .catch(async(error) => {
                log.error("[OAuth] Refreshing existing token: " + error);
                reject(error);
            });
    }
});

exports.providerDeleteToken = async(request) => new Promise(function(resolve, reject) {
    if (request.session.userId) {
        log.info("[Token delete] Deleting approved access token in Canvas for user_id " + request.session.userId);

        axios({
                method: "delete",
                url: canvas.providerBaseUri(request) + "/login/oauth2/token"
            })
            .then((response) => {
                log.info("API Response: " + JSON.stringify(response));
                resolve(response);
            })
            .catch(async(error) => {
                log.error("Deleting approved access token: " + JSON.stringify(error));
                reject(error)
            });
    }
});