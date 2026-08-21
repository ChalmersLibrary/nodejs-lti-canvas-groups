'use strict';

require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const lti = require('ims-lti');
const canvas = require('../canvas');
const oauth = require('../oauth');
const log = require('../log');
const db = require('../db');

/* LTI Consumer Keys and Secrets go into Azure Configuration Key "ltiConsumerKeys", */
/* with format "consumer:secret[,consumer2:secret2]".                               */

const debugLogging = process.env.debugLogging == "true";

/**
 * Nonce store shared by every launch, so that a nonce seen in one launch is known in the
 * next one. A Provider that is constructed without a store gets its own, which makes the
 * replay protection that the store exists for useless.
 */
const nonceStore = new lti.Stores.MemoryStore();

/**
 * The configured consumer keys, read once.
 */
const secrets = new Map(
    (process.env.ltiConsumerKeys ?? '')
        .split(',')
        .filter((entry) => entry.includes(':'))
        .map((entry) => {
            const [consumerKey, ...secretParts] = entry.split(':');

            log.info("[LTI] Added consumer key for '" + consumerKey + "'.");

            /* The secret may itself contain a colon. */
            return [consumerKey, secretParts.join(':')];
        })
);

let developmentLtiData;

if (process.env.NODE_ENV === 'development') {
    try {
        developmentLtiData = JSON.parse(fs.readFileSync('mock-lti.json', 'utf8'));
    }
    catch (error) {
        log.error("[LTI] Reading mock-lti.json: " + error);
    }
}

/**
 * Session as text for debug logging, without the token data. Access tokens and refresh
 * tokens must never be written to the log; the refresh token is long lived and gives
 * full API access as the user to anyone who can read the log stream.
 */
const sessionForLog = (session) => {
    const { token, ...rest } = session;

    return JSON.stringify({
        ...rest,
        token: token ? { token_type: token.token_type, expires_at_utc: token.expires_at_utc } : undefined
    });
};

const getSecret = (consumerKey) => {
    const secret = secrets.get(consumerKey);

    if (secret === undefined) {
        const error = new Error("Unknown consumer '" + consumerKey + "'.");
        error.status = 403;

        throw error;
    }

    return secret;
};

/**
 * ims-lti validates with a callback. This is the same thing as a promise, so that the
 * launch below reads as the sequence of steps that it is.
 */
const validateLaunch = (provider, req) => new Promise((resolve, reject) => {
    provider.valid_request(req, (err, isValid) => {
        if (err || !isValid) {
            const error = err ?? new Error('The LTI request is not valid.');

            /* A bad signature, a stale timestamp or a replayed nonce is a rejected request, */
            /* not a fault in the application, so it must not be answered with a 500.        */
            error.status ??= 401;

            return reject(error);
        }

        resolve(true);
    });
});

exports.mockLocalSession = (req) => {
    if (process.env.NODE_ENV !== 'development' || !developmentLtiData || !process.env.localCanvasDeveloperToken) {
        return;
    }

    req.session.contextId = developmentLtiData.context_id;
    req.session.contextTitle = developmentLtiData.context_title;
    req.session.userId = developmentLtiData.user_id;
    req.session.fullname = developmentLtiData.lis_person_name_full;
    req.session.canvasUserId = developmentLtiData.custom_canvas_user_id;
    req.session.canvasCourseId = developmentLtiData.custom_canvas_course_id;
    req.session.canvasEnrollmentState = developmentLtiData.custom_canvas_enrollment_state;
    req.session.canvasApiDomain = developmentLtiData.custom_canvas_api_domain;
    req.session.token = {
        access_token: process.env.localCanvasDeveloperToken,
        token_type: "Bearer",
        refresh_token: ""
    };

    log.info("[LTI] Mocked up local session from development LTI data and local development token.");
    log.info("[LTI] " + sessionForLog(req.session));
};

/**
 * Copies the launch data that is specific to this launch into the session. Called both for
 * a session that already exists and for one that has just been created, since a user can
 * launch the tool from another course in the same session.
 */
const applyLaunchContext = (session, provider) => {
    session.contextId = provider.context_id;
    session.contextTitle = provider.context_title;
    session.canvasCourseId = provider.body.custom_canvas_course_id;
    session.canvasEnrollmentState = provider.body.custom_canvas_enrollment_state;
    session.canvasLocale = provider.body.launch_presentation_locale;
    session.canvasApiDomain = provider.body.custom_canvas_api_domain;
};

/**
 * Copies the data about the user into the session.
 */
const applyLaunchUser = (session, provider) => {
    session.userId = provider.userId;
    session.username = provider.username;
    session.fullname = provider.body.lis_person_name_full;
    session.email = provider.body.lis_person_contact_email_primary;
    session.ltiConsumer = provider.body.tool_consumer_instance_guid;
    session.isInstructor = provider.instructor === true;
    session.isAdmin = provider.admin === true;
    session.isAlumni = provider.alumni === true;
    session.isContentDeveloper = provider.content_developer === true;
    session.isGuest = provider.guest === true;
    session.isManager = provider.manager === true;
    session.isMentor = provider.mentor === true;
    session.isObserver = provider.observer === true;
    session.isStudent = provider.student === true;
    session.canvasUserId = provider.body.custom_canvas_user_id;
};

/**
 * True when Canvas has answered a refresh with http 400, which it does when the approved
 * integration behind the refresh token is gone. The user can remove it themselves in their
 * Canvas settings at any time, and the only way back is a new OAuth flow.
 */
const needsNewAuthorization = (error) =>
    error?.response?.status == 400 || error?.toString().toLowerCase().includes("failed with status code 400");

/**
 * Handles the LTI launch and sends the user on to `page`, through the OAuth flow when there
 * is no usable token for the Canvas API.
 */
exports.handleLaunch = (page) => async function (req, res, next) {
    log.info("[HandleLaunch] Target page: " + page);

    if (debugLogging) {
        log.info(JSON.stringify(req.body));
    }

    try {
        if (!req.body) {
            const error = new Error('Expected a body');
            error.status = 400;

            throw error;
        }

        const consumerKey = req.body.oauth_consumer_key;

        if (!consumerKey) {
            const error = new Error('Expected a consumer');
            error.status = 422;

            throw error;
        }

        const provider = new lti.Provider(consumerKey, getSecret(consumerKey), nonceStore);

        await validateLaunch(provider, req);

        if (debugLogging) {
            log.info("[LTI] Data: " + JSON.stringify(provider.body));
        }

        const hasSessionToken = req.session?.token?.expires_at_utc !== undefined;

        applyLaunchContext(req.session, provider);

        if (!hasSessionToken) {
            applyLaunchUser(req.session, provider);
        }

        /* No explicit save here: express-session writes the session when the response ends, */
        /* and an extra save writes a snapshot of the session as it looks right now, which   */
        /* can overwrite the token that is written to it further down.                       */
        log.info("[LTI] Session id: " + req.session.id);
        log.info("[Session] Context is " + req.session.contextId + ", course id " + req.session.canvasCourseId + ", " + req.session.contextTitle);

        if (debugLogging) {
            log.info("[LTI] " + sessionForLog(req.session));
        }

        if (!hasSessionToken) {
            log.info("[Session] No token in session, looking for one in the database.");

            const tokenData = await db.getClientData(provider.userId, canvas.providerEnvironment(req));

            if (!tokenData) {
                log.info("[Session] No token data in db for user_id '" + provider.userId + "', forcing OAuth flow.");

                return res.redirect('/oauth');
            }

            req.session.token = tokenData;
        }

        const expiry = new Date(Date.parse(req.session.token.expires_at_utc));

        log.info("[Session] User session " + req.session.id + ", token expires: " + expiry.toISOString());

        if (expiry > new Date()) {
            log.info("[Session] OAuth Token for API is OK.");

            return res.redirect('/' + page);
        }

        log.info("[Session] OAuth Token for API has expired, refreshing.");

        try {
            await oauth.providerRefreshToken(req);

            return res.redirect('/' + page);
        }
        catch (error) {
            log.error("[Session] Refreshing the token: " + error);

            if (needsNewAuthorization(error)) {
                log.info("[Session] Token refresh failed with http error 400, redirect to OAuth flow.");

                return res.redirect('/oauth');
            }

            return res.redirect('/error/text/Token+expired+but+error+during+refresh');
        }
    }
    catch (error) {
        log.error("[HandleLaunch] " + error);

        return next(error);
    }
};
