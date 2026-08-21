'use strict';

require('dotenv').config({ quiet: true });
const LinkHeader = require('http-link-header');
const NodeCache = require('node-cache');
const axios = require('axios');
const oauth = require('../oauth');
const log = require('../log');
const db = require('../db');

/* This module handles communication between LTI Application and Canvas, using Canvas API V1. */

const canvasApiPath = "/api/v1";
const CACHE_TTL = (parseInt(process.env.canvasApiCacheSecondsTTL) > 0 ? parseInt(process.env.canvasApiCacheSecondsTTL) : 900);
const CACHE_TTL_SHORT = 30;
const CACHE_CHECK_EXPIRE = 600;
const API_PER_PAGE = 50;

/* How many times a page is asked for again after Canvas has rejected the access token. */
const API_MAX_ATTEMPTS = 4;

/* How many groups or categories are read from Canvas at the same time. Compiling the view */
/* for a course means one request per category plus one per group, and doing them strictly  */
/* one after the other is what makes the page slow. Set it to 1 for the old behaviour if    */
/* Canvas starts answering 403 because of its own rate limiting.                            */
const API_CONCURRENCY = parseInt(process.env.canvasApiConcurrency) > 0 ? parseInt(process.env.canvasApiConcurrency) : 5;

log.info("[CanvasApi] Cache TTL: " + CACHE_TTL + ", concurrency: " + API_CONCURRENCY);

/* Cache the results of API calls for a shorter period, to ease the load on API servers */
/* and make load time bearable for the user.                                            */

const caches = [
  { name: "groupCategoriesCache", dashboard: true, reads: 0, writes: 0, bucket: new NodeCache({ stdTTL: CACHE_TTL, checkperiod: CACHE_CHECK_EXPIRE }) },
  { name: "groupUsersCache", dashboard: true, reads: 0, writes: 0, bucket: new NodeCache({ stdTTL: CACHE_TTL, checkperiod: CACHE_CHECK_EXPIRE }) },
  { name: "categoryGroupsCache", dashboard: true, reads: 0, writes: 0, bucket: new NodeCache({ stdTTL: CACHE_TTL, checkperiod: CACHE_CHECK_EXPIRE }) },
  { name: "assignmentCache", dashboard: true, reads: 0, writes: 0, bucket: new NodeCache({ stdTTL: CACHE_TTL, checkperiod: CACHE_CHECK_EXPIRE }) },
  { name: "assignmentGradeCache", dashboard: true, reads: 0, writes: 0, bucket: new NodeCache({ stdTTL: CACHE_TTL_SHORT, checkperiod: CACHE_CHECK_EXPIRE }) }
];

const cacheByName = new Map(caches.map((cache) => [cache.name, cache]));

for (const cache of caches) {
  cache.bucket.on('expired', (key) => {
    log.info(`[Cache] Expired NodeCache entry for ${cache.name} key '${key}'.`);
  });
}

/**
 * A cached value, or undefined when there is none.
 *
 * node-cache used to have an errorOnMissing option that made get() throw on a miss, and
 * the code here was built around catching that. Version 5 removed it, so a miss is now
 * what it says on the tin: undefined. Nothing is ever cached as undefined.
 */
const readCache = (cacheName, key) => {
  const cache = cacheByName.get(cacheName);
  const value = cache.bucket.get(key);

  if (value === undefined) {
    return undefined;
  }

  cache.reads++;

  log.info(`[Cache] Using found NodeCache entry in ${cacheName} for key ${key}.`);
  log.debug(`[Cache] Statistics: ${JSON.stringify(cache.bucket.getStats())}`);

  return value;
};

const writeCache = (cacheName, key, value) => {
  const cache = cacheByName.get(cacheName);

  cache.bucket.set(key, value);
  cache.writes++;

  log.debug(`[Cache] Data cached in ${cacheName} for ${CACHE_TTL / 60} minutes, keys: ${cache.bucket.keys()}`);
};

/**
 * Maps over items with at most `limit` of them in flight at a time, keeping the order of
 * the results. Promise.all over everything at once would open as many connections to
 * Canvas as there are groups in a course.
 */
const mapWithConcurrency = async (items, limit, mapper) => {
  const results = new Array(items.length);
  let next = 0;

  const worker = async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await mapper(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));

  return results;
};

/**
 * Canvas environment.
 */
exports.providerEnvironment = (request) => {
  const providerBaseUri = exports.providerBaseUri(request);
  const isTest = providerBaseUri.indexOf("test.in") > 0;
  const isBeta = providerBaseUri.indexOf("beta.in") > 0;

  return (isTest ? 'test' : (isBeta ? 'beta' : (providerBaseUri == '//' ? 'local_dev' : 'production')));
};

/**
 * Canvas base uri.
 */
exports.providerBaseUri = (request) => {
  if (process.env.canvasBaseUri) {
    return process.env.canvasBaseUri;
  }

  if (request?.session?.canvasApiDomain) {
    return 'https://' + request.session.canvasApiDomain;
  }

  return '//';
};

/**
 * Complete Canvas uri up to API endpoint.
 */
exports.apiPath = (request) => {
  const baseUri = exports.providerBaseUri(request);

  return baseUri == '//' ? canvasApiPath : baseUri + canvasApiPath;
};

/**
 * True when the token is known to have expired. A token without an expiry, like the one
 * used for local development, is never treated as expired.
 */
const tokenHasExpired = (token) => {
  if (!token?.expires_at_utc) {
    return false;
  }

  const expires = new Date(token.expires_at_utc);

  return !isNaN(expires.getTime()) && expires < new Date();
};

/**
 * Returns the OAuth token to use for API calls, or null if there is none.
 *
 * The database is the source of truth for the token and the session is only a cache of it.
 * Sessions are written by several requests at once, so a session can hold no token at all
 * or a token that was replaced by a refresh in a request just before this one. Every
 * refresh writes to the database first, so it always has the current token, and it is read
 * whenever the session has nothing usable. A token that is expired in the database as well
 * is still returned; it is refreshed by the normal 401 handling where it is used.
 */
exports.sessionToken = async (request) => {
  const sessionToken = request?.session?.token?.access_token ? request.session.token : null;

  if (sessionToken && !tokenHasExpired(sessionToken)) {
    return sessionToken;
  }

  const tokenData = await exports.tokenFromDatabase(request);

  if (tokenData) {
    log.info("[Session] " + (sessionToken
      ? "Session token had expired, replaced it with the token in database"
      : "Session had no token data, restored it from the database") +
      " for user_id '" + request.session.userId + "', expires: " + tokenData.expires_at_utc + ".");

    return tokenData;
  }

  return sessionToken;
};

/**
 * Reads the current token from the database and puts it in the session, or returns null if
 * there is none. Used both when the session has nothing usable and when Canvas rejects the
 * token that was used, since another request may have stored a new one in between.
 */
exports.tokenFromDatabase = async (request) => {
  if (!request?.session?.userId) {
    return null;
  }

  try {
    const tokenData = await db.getClientData(request.session.userId, exports.providerEnvironment(request));

    if (!tokenData) {
      log.info("[Session] No token in the database for user_id '" + request.session.userId + "'.");

      return null;
    }

    request.session.token = tokenData;

    return tokenData;
  }
  catch (error) {
    log.error("[Session] Reading the token for user_id '" + request.session.userId + "': " + error);

    return null;
  }
};

/**
 * Error used when the session has no token, so callers can send the user through OAuth again.
 */
exports.noSessionTokenError = () => {
  const error = new Error("No OAuth token in session, reauthorization is needed.");
  error.name = "NoSessionTokenError";

  return error;
};

/**
 * Error used when the token can not be refreshed, so callers can send the user through OAuth
 * again. Canvas answers a refresh with http 400 when the approved integration behind the token
 * is gone, which the user can remove themselves in their Canvas settings at any time.
 */
exports.reauthorizationNeededError = () => {
  const error = new Error("The token could not be refreshed, reauthorization is needed.");
  error.name = "ReauthorizationNeededError";

  return error;
};

/**
 * The Authorization header value for an API call. A system token is passed in for the
 * anonymous endpoints; everything else uses the token of the user in the session.
 */
const authorizationHeader = async (request, accessToken) => {
  if (accessToken) {
    return "Bearer " + accessToken;
  }

  const token = await exports.sessionToken(request);

  if (!token) {
    throw exports.noSessionTokenError();
  }

  return token.token_type + " " + token.access_token;
};

/**
 * Deals with a 401 from Canvas.
 *
 * Another request may have stored a new token just before this one, and the session can
 * still be serving the token it held before that, so only refresh when the database holds
 * the same token that Canvas has just rejected.
 */
const handleRejectedToken = async (request) => {
  const rejectedToken = request.session?.token?.access_token;
  const currentToken = await exports.tokenFromDatabase(request);

  if (currentToken && currentToken.access_token != rejectedToken) {
    log.info("[API] The token had already been replaced, continuing with the one in database.");

    return;
  }

  try {
    await oauth.providerRefreshToken(request);
  }
  catch (refreshError) {
    log.error("[API] The token could not be refreshed: " + refreshError);

    throw exports.reauthorizationNeededError();
  }
};

const nextPageUri = (linkHeader) => {
  if (!linkHeader) {
    return null;
  }

  const link = LinkHeader.parse(linkHeader);

  return link.has("rel", "next") ? link.get("rel", "next")[0].uri : null;
};

/**
 * Reads every page of a Canvas API collection, following the Link header, and returns all
 * records from all pages.
 *
 * Canvas answers 401 with a www-authenticate header when the access token has expired; the
 * token is then dealt with and the same page asked for again, at most API_MAX_ATTEMPTS times.
 * A 401 without that header means the account is not allowed to use the endpoint at all,
 * which no amount of refreshing helps.
 */
const apiRequestAllPages = async (firstPath, request, { accessToken, treat404AsEmpty = false } = {}) => {
  const records = [];
  let path = firstPath;
  let attempts = 0;

  while (path) {
    log.info("[API] GET " + path);

    try {
      const response = await axios.get(path, {
        headers: {
          "User-Agent": "Chalmers/Azure/Request",
          "Authorization": await authorizationHeader(request, accessToken)
        }
      });

      if (Array.isArray(response.data)) {
        records.push(...response.data);
      }
      else if (response.data) {
        records.push(response.data);
      }

      path = nextPageUri(response.headers["link"]);
    }
    catch (error) {
      const status = error.response?.status;

      if (status == 404 && treat404AsEmpty) {
        log.error("[API] Not found, possibly a deleted group category referenced from a self signup config. Returning empty data.");

        return records;
      }

      if (status == 401 && error.response?.headers?.['www-authenticate'] && !accessToken) {
        if (++attempts >= API_MAX_ATTEMPTS) {
          log.error(`[API] Canvas rejected the access token ${attempts} times, giving up.`);

          throw exports.reauthorizationNeededError();
        }

        await handleRejectedToken(request);

        continue;
      }

      if (status == 401) {
        log.error("[API] Not authorized in Canvas for use of this API endpoint.");
      }
      else {
        log.error("[API] Error: " + error);
      }

      throw error;
    }
  }

  return records;
};

/* Requests that are already on their way to Canvas, so that several requests for the same */
/* course do not each start their own round of API calls before the first one has answered. */
const inFlight = new Map();

/**
 * A cached, paginated Canvas API collection. Every endpoint below is this plus a path and,
 * where the whole record is not worth keeping, a transform of the records.
 */
const cachedApiCollection = async ({ cacheName, key, path, request, accessToken, treat404AsEmpty, transform }) => {
  const cached = readCache(cacheName, key);

  if (cached !== undefined) {
    return cached;
  }

  const inFlightKey = `${cacheName}:${key}`;
  const pending = inFlight.get(inFlightKey);

  if (pending) {
    log.debug(`[Cache] Waiting for the request already in flight for ${inFlightKey}.`);

    return pending;
  }

  const promise = (async () => {
    const records = await apiRequestAllPages(path, request, { accessToken, treat404AsEmpty });
    const data = transform ? transform(records) : records;

    writeCache(cacheName, key, data);

    return data;
  })();

  inFlight.set(inFlightKey, promise);

  try {
    return await promise;
  }
  finally {
    inFlight.delete(inFlightKey);
  }
};

/**
 * The current cache buckets for Canvas API.
 */
exports.cacheBuckets = () => caches;

exports.addCacheRead = (cacheName) => {
  cacheByName.get(cacheName).reads++;
};

exports.addCacheWrite = (cacheName) => {
  cacheByName.get(cacheName).writes++;
};

/**
 * Cache contents for the statistics pages. Reading from node-cache is not asynchronous.
 */
exports.getCacheStat = () => caches.map((cache) => ({
  name: cache.name,
  reads: cache.reads,
  writes: cache.writes,
  dashboard: cache.dashboard,
  keys: cache.bucket.keys().map((key) => {
    const ttlMs = cache.bucket.getTtl(key);

    return {
      name: key,
      ttl_ms: ttlMs,
      expires_at: ttlMs ? new Date(ttlMs).toLocaleTimeString() : null
    };
  })
}));

/* Get group categories for a specified course. */
exports.getGroupCategories = async (courseId, request) => cachedApiCollection({
  cacheName: 'groupCategoriesCache',
  key: courseId,
  path: `${exports.apiPath(request)}/courses/${courseId}/group_categories?per_page=${API_PER_PAGE}`,
  request
});

/* Get groups for a specified category. */
exports.getCategoryGroups = async (categoryId, request, accessToken) => cachedApiCollection({
  cacheName: 'categoryGroupsCache',
  key: categoryId,
  path: `${exports.apiPath(request)}/group_categories/${categoryId}/groups?per_page=${API_PER_PAGE}`,
  request,
  accessToken,
  treat404AsEmpty: true
});

/* Get users (not members) for a specified group. */
exports.getGroupUsers = async (groupId, request) => cachedApiCollection({
  cacheName: 'groupUsersCache',
  key: groupId,
  path: `${exports.apiPath(request)}/groups/${groupId}/users?include[]=avatar_url&include[]=email&per_page=${API_PER_PAGE}`,
  request
});

/**
 * List assignments in course that have grading type "points" and are published.
 * Used by administrator/teacher to create a Group Rule.
 *
 * @param {Number} courseId
 * @param {Object} request
 * @returns Valid assignments in course to use with Group Rule.
 */
exports.getCourseAssignments = async (courseId, request) => cachedApiCollection({
  cacheName: 'assignmentCache',
  key: courseId,
  path: `${exports.apiPath(request)}/courses/${courseId}/assignments?per_page=${API_PER_PAGE}`,
  request,
  transform: (records) => records
    .filter((record) => record.grading_type == "points" && record.published === true)
    .map((record) => ({
      id: record.id,
      name: record.name,
      grading_type: record.grading_type,
      points_possible: record.points_possible,
      published: record.published,
      locked_for_user: record.locked_for_user
    }))
});

/**
 * Get assignment submissions and the relevant grade for a particular user.
 * Note: Uses system account rights to be able to read this information in anonymous request.
 *
 * The submissions of the whole assignment are cached and the one for the user picked out of
 * them, since the endpoint is called once per student from the Canvas course page.
 *
 * @param {Number} courseId
 * @param {Number} assignmentId
 * @param {Number} userId
 * @param {Object} request
 * @param {String} accessToken System token, for the anonymous public endpoint.
 * @returns Grade and related information, or an empty object when the user has no submission.
 */
exports.getAssignmentGrade = async (courseId, assignmentId, userId, request, accessToken) => {
  const submissions = await cachedApiCollection({
    cacheName: 'assignmentGradeCache',
    key: assignmentId,
    path: `${exports.apiPath(request)}/courses/${courseId}/assignments/${assignmentId}/submissions?per_page=${API_PER_PAGE}`,
    request,
    accessToken,
    transform: (records) => records.map((record) => ({
      user_id: record.user_id,
      workflow_state: record.workflow_state,
      submitted_at: record.submitted_at,
      score: record.score,
      entered_score: record.entered_score
    }))
  });

  return submissions.find((submission) => submission.user_id == userId) ?? {};
};

/**
 * Render time, in the shape the views expect.
 */
const elapsed = (startedAt) => {
  const elapsedNs = process.hrtime.bigint() - startedAt;

  return {
    running_s: Number(elapsedNs / 1000000000n),
    running_ms: Number(elapsedNs % 1000000000n) / 1000000
  };
};

/**
 * Compile category groups data for CSV export.
 */
exports.compileCategoryGroupsData = async (categoryId, request) => {
  const startedAt = process.hrtime.bigint();

  const groups = await exports.getCategoryGroups(categoryId, request);

  const groupsWithUsers = await mapWithConcurrency(groups, API_CONCURRENCY, async (group) => {
    const users = await exports.getGroupUsers(group.id, request);

    return {
      id: group.id,
      name: group.name,
      description: group.description,
      category_id: group.group_category_id,
      users: users.map((user) => ({
        userId: user.id,
        name: user.name,
        sortableName: user.sortable_name,
        email: user.email,
        login_id: user.login_id,
        avatarUrl: user.avatar_url
      }))
    };
  });

  return {
    user: {
      fullname: request.session.fullname,
      email: request.session.email,
      id: request.session.userId
    },
    context: {
      id: request.session.contextId,
      courseId: request.session.canvasCourseId,
      enrollmentState: request.session.canvasEnrollmentState,
      title: request.session.contextTitle
    },
    categories: [{
      id: categoryId,
      groups: groupsWithUsers
    }],
    statistics: elapsed(startedAt)
  };
};

/**
 * Compile groups data for web view.
 */
exports.compileGroupsData = async (canvasCourseId, request) => {
  const startedAt = process.hrtime.bigint();

  const categories = await exports.getGroupCategories(canvasCourseId, request);

  const categoriesWithGroups = await mapWithConcurrency(categories, API_CONCURRENCY, async (category) => {
    const groups = await exports.getCategoryGroups(category.id, request);

    const groupsWithUsers = await mapWithConcurrency(groups, API_CONCURRENCY, async (group) => {
      const users = await exports.getGroupUsers(group.id, request);

      return {
        id: group.id,
        name: group.name,
        description: group.description,
        category_id: group.group_category_id,
        users: users.map((user) => ({
          userId: user.id,
          name: user.name,
          sortableName: user.sortable_name,
          email: user.email,
          avatarUrl: user.avatar_url
        }))
      };
    });

    const selfSignupEnabled = category.self_signup == 'enabled' || category.self_signup == 'restricted';

    return {
      id: category.id,
      name: category.name,
      self_signup: {
        enabled: selfSignupEnabled,
        ruleset: selfSignupEnabled ? await db.getSelfSignupConfig(canvasCourseId, category.id) : null
      },
      groups: groupsWithUsers
    };
  });

  /* Note: the compiled data is deliberately not logged. It holds the name and email */
  /* address of every student in the course.                                         */

  return {
    user: {
      fullname: request.session.fullname,
      id: request.session.userId
    },
    course: {
      id: request.session.canvasCourseId,
      contextTitle: request.session.contextTitle,
      categories: categoriesWithGroups
    },
    statistics: elapsed(startedAt)
  };
};

/**
 * Drops every cached entry that belongs to a course, including the groups and users below
 * its categories.
 */
exports.clearCourseCache = async (courseId, request) => {
  let totalDeletedEntries = 0;

  const categories = await exports.getGroupCategories(courseId, request);

  await mapWithConcurrency(categories, API_CONCURRENCY, async (category) => {
    const groups = await exports.getCategoryGroups(category.id, request);

    for (const group of groups) {
      totalDeletedEntries += cacheByName.get('groupUsersCache').bucket.del(group.id);
    }

    totalDeletedEntries += cacheByName.get('categoryGroupsCache').bucket.del(category.id);
  });

  totalDeletedEntries += cacheByName.get('groupCategoriesCache').bucket.del(courseId);
  totalDeletedEntries += cacheByName.get('assignmentCache').bucket.del(courseId);

  log.info(`[Cache] Deleted ${totalDeletedEntries} NodeCache entries for courseId ${courseId}.`);

  return totalDeletedEntries;
};
