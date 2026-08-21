/* Helpers for driving the application from a test: a signed LTI launch and a cookie jar. */
'use strict';

const crypto = require('node:crypto');

/* The percent encoding that the OAuth 1.0a signature base string uses. */
const specialEncode = (value) => encodeURIComponent(String(value))
    .replace(/[!'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/\*/g, '%2A');

/**
 * The HMAC-SHA1 signature of a launch, the way ims-lti builds it: the method, the launch
 * url and the sorted parameters, joined with & and each part percent encoded.
 */
const signLaunch = (launchUrl, body, secret) => {
    const params = Object.entries(body)
        .filter(([key]) => key !== 'oauth_signature')
        .map(([key, value]) => `${key}=${specialEncode(value)}`)
        .sort()
        .join('&');

    const base = ['POST', specialEncode(launchUrl), specialEncode(params)].join('&');

    return crypto.createHmac('sha1', secret + '&').update(base).digest('base64');
};

/**
 * A launch body for a signed and valid launch. Each call gets a fresh nonce and timestamp,
 * so two launches from the same test are not rejected as a replay.
 */
const launchBody = (overrides = {}) => ({
    lti_message_type: 'basic-lti-launch-request',
    lti_version: 'LTI-1p0',
    resource_link_id: 'rl-1',
    context_id: 'ctx-1',
    context_title: 'Testkurs 2026',
    user_id: 'lti-user-1',
    roles: 'Instructor',
    lis_person_name_full: 'Test Teacher',
    lis_person_contact_email_primary: 'teacher@chalmers.se',
    tool_consumer_instance_guid: 'chalmers',
    custom_canvas_user_id: '777',
    custom_canvas_course_id: '123',
    custom_canvas_enrollment_state: 'active',
    custom_canvas_api_domain: '127.0.0.1',
    launch_presentation_locale: 'sv',
    oauth_consumer_key: 'testconsumer',
    oauth_nonce: crypto.randomBytes(12).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: '1.0',
    ...overrides
});

/**
 * A signed launch body, ready to be posted as application/x-www-form-urlencoded.
 */
const signedLaunch = (launchUrl, secret, overrides = {}) => {
    const body = launchBody(overrides);
    body.oauth_signature = signLaunch(launchUrl, body, secret);

    return body;
};

/**
 * Just enough cookie handling to keep a session across requests.
 */
class Jar {
    #cookies = new Map();

    header() {
        return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    }

    store(response) {
        for (const raw of response.headers.getSetCookie?.() ?? []) {
            const [pair] = raw.split(';');
            const separator = pair.indexOf('=');

            this.#cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
        }
    }
}

module.exports = { specialEncode, signLaunch, launchBody, signedLaunch, Jar };
