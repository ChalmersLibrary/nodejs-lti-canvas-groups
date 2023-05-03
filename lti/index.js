'use strict';

require('dotenv').config();
const session = require('express-session');
const lti = require('ims-lti');
const NodeCache = require('node-cache');
const nodeCacheNonceStore = require('../node-cache-nonce');
const canvas = require('../canvas');
const oauth = require('../oauth');
const log = require('../log');
const db = require('../db');

const myCache = new NodeCache();
const nonceStore = new nodeCacheNonceStore(myCache);

/* LTI Consumer Keys and Secrets go into Azure Configuration Key "ltiConsumerKeys", */
/* with format "consumer:secret[,consumer2:secret2]".                               */

const consumerKeys = process.env.ltiConsumerKeys;
const debugLogging = process.env.debugLogging == "true" ? true : false;
var secrets = [];

const getSecret = (consumerKey, callback) => {
    if (consumerKeys && secrets.length == 0) {
        for (const key of consumerKeys.split(',')) {
            secrets.push({
                "consumerKey": key.split(':')[0],
                "secret": key.split(':')[1]
            });

            log.info("Added consumer key for '" + key.split(':')[0] + "'.");
        }
    }

    for (const secret of secrets) {
        if (secret.consumerKey == consumerKey) {
            return callback(null, secret.secret);
        }
    }

    let err = new Error("Unknown consumer '" + consumerKey + "'.");
    err.status = 403;

    return callback(err);
};

exports.handleLaunch = (page) => function(req, res, next) {
    log.info("[HandleLaunch] Target page: " + page);

    if (!req.body) {
        let err = new Error('Expected a body');
        err.status = 400;
        log.error(err);
        return next(err);
    }

    const consumerKey = req.body.oauth_consumer_key;
    if (!consumerKey) {
        let err = new Error('Expected a consumer');
        err.status = 422;
        log.error(err);
        return next(err);
    }

    getSecret(consumerKey, (err, consumerSecret) => {
        if (err) {
            return next(err);
        }

        const provider = new lti.Provider(consumerKey, consumerSecret, nonceStore, lti.HMAC_SHA1);

        provider.valid_request(req, async(err, isValid) => {
            if (err) {
                return next(err);
            }
            if (isValid) {
                if (debugLogging)
                    log.info("LTI Data:" + JSON.stringify(provider.body));

                if (typeof req.session !== 'undefined' && typeof req.session.token !== 'undefined' && typeof req.session.token.expires_at_utc !== 'undefined') {
                    req.session.contextId = provider.context_id;
                    req.session.contextTitle = provider.context_title;
                    req.session.canvasCourseId = provider.body.custom_canvas_course_id;
                    req.session.canvasEnrollmentState = provider.body.custom_canvas_enrollment_state;
                    req.session.canvasLocale = provider.body.launch_presentation_locale;
                    req.session.canvasApiDomain = provider.body.custom_canvas_api_domain;

                    await req.session.save(function(err) {
                        log.info("[LTI] Updated session id: " + req.session.id);
                    });

                    log.info("[Session] Context is " + req.session.contextId + ", course id " + req.session.canvasCourseId + ", " + req.session.contextTitle);

                    const now = new Date();
                    const expiry = new Date(Date.parse(req.session.token.expires_at_utc));

                    log.info("[Session] User session exists: " + req.session.id + ", expires: " + expiry);
                    
                    if (debugLogging)
                        log.info(JSON.stringify(req.session));
                    
                    if (expiry > now) {
                        log.info("[Session] OAuth Token for API is OK.");
                        res.redirect('/' + page);
                    } else if (expiry < now) {
                        log.info("[Session] OAuth Token for API has expired, refreshing.");
                        await oauth.providerRefreshToken(req)
                            .then(() => {
                                res.redirect('/' + page);
                            })
                            .catch((error) => {
                                log.error(error);

                                if (error.toString().toLowerCase().includes("failed with status code 400")) {
                                    log.info("[Session] Token refresh failed with http error 400, redirect to OAuth flow.")
                                    res.redirect("/oauth");
                                } else {
                                    res.redirect('/error/text/Token+expired+below+but+error+during+refresh+session+exists');
                                }
                            });
                    } else if (expiry == now) {
                        log.info("[Session] The two dates are EXACTLY the same, believe it or not.");
                        await oauth.providerRefreshToken(req)
                            .then(() => {
                                res.redirect('/' + page);
                            })
                            .catch((error) => {
                                log.error(error);

                                if (error.toString().toLowerCase().includes("failed with status code 400")) {
                                    log.info("[Session] Token refresh failed with http error 400, redirect to OAuth flow.")
                                    res.redirect("/oauth");
                                } else {
                                    res.redirect('/error/text/Token+expired+equal+but+error+during+refresh+session+exists');
                                }
                            });
                    } else {
                        log.info("[Session] No OAuth Token for API, forcing OAuth flow.");
                        res.redirect('/oauth');
                    }
                } else {
                    log.info("[LTI] Regenerating session...");

                    req.session.contextId = provider.context_id;
                    req.session.contextTitle = provider.context_title;
                    req.session.userId = provider.userId;
                    req.session.username = provider.username;
                    req.session.fullname = provider.body.lis_person_name_full;
                    req.session.email = provider.body.lis_person_contact_email_primary;
                    req.session.ltiConsumer = provider.body.tool_consumer_instance_guid;
                    req.session.isInstructor = provider.instructor === true;
                    req.session.isAdmin = provider.admin === true;
                    req.session.isAlumni = provider.alumni === true;
                    req.session.isContentDeveloper = provider.content_developer === true;
                    req.session.isGuest = provider.guest === true;
                    req.session.isManager = provider.manager === true;
                    req.session.isMentor = provider.mentor === true;
                    req.session.isObserver = provider.observer === true;
                    req.session.isStudent = provider.student === true;
                    req.session.canvasUserId = provider.body.custom_canvas_user_id;
                    req.session.canvasCourseId = provider.body.custom_canvas_course_id;
                    req.session.canvasEnrollmentState = provider.body.custom_canvas_enrollment_state;
                    req.session.canvasLocale = provider.body.launch_presentation_locale;
                    req.session.canvasApiDomain = provider.body.custom_canvas_api_domain;

                    await req.session.save(function(err) {
                        log.info("[LTI] Saved session id: " + req.session.id);
                    });

                    if (debugLogging) {
                        log.info(JSON.stringify(req.session));
                    }

                    await db.getClientData(provider.userId, canvas.providerEnvironment(req))
                        .then(async (value) => {
                            req.session.token = value;

                            const now = new Date();
                            const expiry = new Date(Date.parse(req.session.token.expires_at_utc));

                            if (expiry > now) {
                                log.info("[Session] OAuth Token for API is OK.");
                                res.redirect('/' + page);
                            } else if (expiry < now) {
                                log.info("[Session] OAuth Token for API has expired, refreshing.");
                                await oauth.providerRefreshToken(req)
                                    .then(() => {
                                        res.redirect('/' + page);
                                    })
                                    .catch((error) => {
                                        log.error(error);

                                        if (error.toString().toLowerCase().includes("failed with status code 400")) {
                                            log.info("Token refresh failed with http error 400, redirect to OAuth flow.")
                                            res.redirect("/oauth");
                                        } else {
                                            res.redirect('/error/text/Token+expired+below+but+error+during+refresh+session+exists');
                                        }
                                    });
                            } else if (expiry == now) {
                                log.info("[Session] The two dates are EXACTLY the same, believe it or not.");
                                await oauth.providerRefreshToken(req)
                                    .then(() => {
                                        res.redirect('/' + page);
                                    })
                                    .catch((error) => {
                                        log.error(error);

                                        if (error.toString().toLowerCase().includes("failed with status code 400")) {
                                            log.info("Token refresh failed with http error 400, redirect to OAuth flow.")
                                            res.redirect("/oauth");
                                        } else {
                                            res.redirect('/error/text/Token+expired+equal+but+error+during+refresh+session+regenerated');
                                        }
                                    });
                            } else {
                                log.info("[Session] No OAuth Token for API, forcing OAuth flow.");
                                res.redirect('/oauth');
                            }
                        })
                        .catch((error) => {
                            log.error(error);
                            log.info("[Session] No token data in db for user_id '" + provider.userId + "', forcing OAuth flow.");
                            console.log("Session before redirect:");
                            console.log(req.session);
                            res.redirect('/oauth');
                        });
                }
            } else {
                log.error("[Session] The request is NOT valid.");
                return next(err);
            }
        });
    });
};