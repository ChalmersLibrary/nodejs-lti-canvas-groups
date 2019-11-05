'use strict';

const lti = require('ims-lti');
const NodeCache = require('node-cache');
const nodeCacheNonceStore = require('../node-cache-nonce');
const canvas = require('../canvas');
const oauth = require('../oauth');
const db = require('../db');

const myCache = new NodeCache();
const nonceStore = new nodeCacheNonceStore(myCache);

/* LTI Consumer Keys and Secrets go into Azure Configuration Key "ltiConsumerKeys", */
/* with format "consumer:secret[,consumer2:secret2]".                               */

const consumerKeys = process.env.ltiConsumerKeys;
var secrets = [];

const getSecret = (consumerKey, callback) => {
  if (consumerKeys && secrets.length == 0) {
    for (const key of consumerKeys.split(',')) {
      secrets.push({ 
        "consumerKey": key.split(':')[0], 
        "secret": key.split(':')[1] 
      });

      console.log("Added consumer key for '" + key.split(':')[0] + "'.");
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

exports.handleLaunch = (req, res, next) => {
  if (!req.body) {
    let err = new Error('Expected a body');
    err.status = 400;
    return next(err);
  }

  const consumerKey = req.body.oauth_consumer_key;
  if (!consumerKey) {
    let err = new Error('Expected a consumer');
    err.status = 422;
    return next(err);
  }

  getSecret(consumerKey, (err, consumerSecret) => {
    if (err) {
      return next(err);
    }

    const provider = new lti.Provider(consumerKey, consumerSecret, nonceStore, lti.HMAC_SHA1);
    
    provider.valid_request(req, (err, isValid) => {
      if (err) {
        return next(err);
      }
      if (isValid) {
        if (req.session.contextId && req.session.contextId == provider.context_id && typeof req.session.token.expires_at_utc !== 'undefined') {
          console.log("LTI Session is OK.");

          const now = new Date();
          const expiry = new Date(Date.parse(req.session.token.expires_at_utc));

          console.log("now: " + now + "\r\n");
          console.log("token.expires_at_utc (raw): " + req.session.token.expires_at_utc + "\r\n");
          console.log("token.expires_at_utc (Date.parse(expires_at_utc)): " + expiry + "\r\n");

          if (expiry > now) {
            console.log("OAuth Token for API is OK.");
            res.redirect('/groups');
          }
          else if (expiry < now) {
            console.log("OAuth Token for API has expired, refreshing.");
            oauth.providerRefreshToken(req);
            res.redirect('/groups');
          }
          else if (expiry == now) {
            console.log("The two dates are EXACTLY the same, believe it or not.");
            oauth.providerRefreshToken(req);
            res.redirect('/groups');
          }
          else {
            console.log("No OAuth Token for API, forcing OAuth flow.");
            res.redirect('/oauth');
          }
        }
        else {
          req.session.regenerate(err => {
            if (err) next(err);
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
          });

          db.getClientData(provider.userId, canvas.providerEnvironment)
          .then((value) => {
            req.session.token = value;

            const now = new Date();
            const expiry = new Date(Date.parse(req.session.token.expires_at_utc));
  
            console.log("(DB) now: " + now + "\r\n");
            console.log("(DB) token.expires_at_utc (raw): " + req.session.token.expires_at_utc + "\r\n");
            console.log("(DB) token.expires_at_utc (Date.parse(expires_at_utc)): " + expiry + "\r\n");
  
            if (expiry > now) {
              console.log("OAuth Token for API is OK.");
              res.redirect('/groups');
            }
            else if (expiry < now) {
              console.log("OAuth Token for API has expired, refreshing.");
              oauth.providerRefreshToken(req);
              res.redirect('/groups');
            }
            else if (expiry == now) {
              console.log("The two dates are EXACTLY the same, believe it or not.");
              oauth.providerRefreshToken(req);
              res.redirect('/groups');
            }
            else {
              console.log("No OAuth Token for API, forcing OAuth flow.");
              res.redirect('/oauth');
            }
          })
          .catch((error) => {
            console.error(error);
            console.log("No token data in db for user_id '" + provider.userId + "', forcing OAuth flow.");
            res.redirect('/oauth');
          });
        }
      }
      else {
        console.log("The request is NOT valid.");
        return next(err);
      }
    });
  });
};
