'use strict';

require('dotenv').config();
const LinkHeader = require('http-link-header');
const NodeCache = require('node-cache');
const axios = require('axios');
const oauth = require('../oauth');
const log = require('../log');
const db = require('../db');

/* This module handles communication between LTI Application and Canvas, using Canvas API V1. */

const canvasApiPath = "/api/v1";
const CACHE_TTL = (parseInt(process.env.canvasApiCacheSecondsTTL) > 0 ? parseInt(process.env.canvasApiCacheSecondsTTL) : 900);
const CACHE_CHECK_EXPIRE = 600;
const API_PER_PAGE = 50;

log.info("[CanvasApi] Cache TTL: " + CACHE_TTL);

/* Cache the results of API calls for a shorter period, to ease the load on API servers */
/* and make load time bearable for the user.                                            */

const courseGroupsCache = new NodeCache({ errorOnMissing:true, stdTTL: CACHE_TTL, checkperiod: CACHE_CHECK_EXPIRE });
const groupCategoriesCache = new NodeCache({ errorOnMissing:true, stdTTL: CACHE_TTL, checkperiod: CACHE_CHECK_EXPIRE });
const groupUsersCache = new NodeCache({ errorOnMissing:true, stdTTL: CACHE_TTL, checkperiod: CACHE_CHECK_EXPIRE });
const categoryGroupsCache = new NodeCache({ errorOnMissing:true, stdTTL: CACHE_TTL, checkperiod: CACHE_CHECK_EXPIRE });
const memberCache = new NodeCache({ errorOnMissing:true, stdTTL: CACHE_TTL, checkperiod: CACHE_CHECK_EXPIRE });
const userCache = new NodeCache({ errorOnMissing:true, stdTTL: CACHE_TTL, checkperiod: CACHE_CHECK_EXPIRE });
const assignmentCache = new NodeCache({ errorOnMissing:true, stdTTL: CACHE_TTL, checkperiod: CACHE_CHECK_EXPIRE });
const assignmentGradeCache = new NodeCache({ errorOnMissing: true, stdTTL: CACHE_TTL, checkperiod: CACHE_CHECK_EXPIRE });

let caches = [
  {
    name: "courseGroupsCache",
    writes: 0,
    reads: 0,
    dashboard: false,
    bucket: courseGroupsCache
  },
  {
    name: "groupCategoriesCache",
    writes: 0,
    reads: 0,
    dashboard: true,
    bucket: groupCategoriesCache
  },
  {
    name: "groupUsersCache",
    writes: 0,
    reads: 0,
    dashboard: true,
    bucket: groupUsersCache
  },
  {
    name: "categoryGroupsCache",
    writes: 0,
    reads: 0,
    dashboard: true,
    bucket: categoryGroupsCache
  },
  {
    name: "memberCache",
    writes: 0,
    reads: 0,
    dashboard: false,
    bucket: memberCache
  },
  {
    name: "userCache",
    writes: 0,
    reads: 0,
    dashboard: false,
    bucket: userCache
  },
  {
    name: "assignmentCache",
    writes: 0,
    reads: 0,
    dashboard: true,
    bucket: assignmentCache
  },
  {
    name: "assignmentGradeCache",
    writes: 0,
    reads: 0,
    dashboard: true,
    bucket: assignmentGradeCache
  }
];

courseGroupsCache.on('expired', function(key) {
  log.info("[Cache] Expired NodeCache entry for courseGroupsCache key '" + key + "'.");
});
groupCategoriesCache.on('expired', function(key) {
  log.info("[Cache] Expired NodeCache entry for groupCategoriesCache key '" + key + "'.");
});
groupUsersCache.on('expired', function(key) {
  log.info("[Cache] Expired NodeCache entry for groupUsersCache key '" + key + "'.");
});
categoryGroupsCache.on('expired', function(key) {
  log.info("[Cache] Expired NodeCache entry for categoryGroupsCache key '" + key + "'.");
});
memberCache.on('expired', function(key) {
  log.info("[Cache] Expired NodeCache entry for memberCache key '" + key + "'.");
});
userCache.on('expired', function(key) {
  log.info("[Cache] Expired NodeCache entry for userCache key '" + key + "'.");
});
assignmentCache.on('expired', function(key) {
  log.info("[Cache] Expired NodeCache entry for assignmentCache key '" + key + "'.");
});
assignmentGradeCache.on('expired', function(key) {
  log.info("[Cache] Expired NodeCache entry for assignmentGradeCache key '" + key + "'.");
});

/**
 * Canvas environment.
 */
exports.providerEnvironment = (request) => {
  try {
    const providerBaseUri = exports.providerBaseUri(request);
    const isTest = providerBaseUri.indexOf("test.in") > 0 ? true : false;
    const isBeta = providerBaseUri.indexOf("beta.in") > 0 ? true : false;
    
    return (isTest ? 'test' : (isBeta ? 'beta' : (providerBaseUri == '//' ? 'local_dev' : 'production')));
  }
  catch (error) {
    throw(new Error(error));
  }
};

/**
 * Canvas base uri.
 */
exports.providerBaseUri = (request) => {
  try {
    if (process.env.canvasBaseUri) {
      return(process.env.canvasBaseUri);
    }
    else if (request.session && request.session.canvasApiDomain) {
      return('https://' + request.session.canvasApiDomain);
    }
    else {
      return('//');
    }
  }
  catch (error) {
    throw(new Error(error));
  }
};

/**
 * Complete Canvas uri up to API endpoint.
 */
exports.apiPath = (request) => {
  try {
    if (process.env.canvasBaseUri) {
      return(process.env.canvasBaseUri + canvasApiPath);
    }
    else if (request.session && request.session.canvasApiDomain) {
      return('https://' + request.session.canvasApiDomain + canvasApiPath);
    }
    else {
      return(canvasApiPath);
    }
  }
  catch (error) {
    throw(new Error(error));
  }
};

exports.cacheStat = async () => new Promise(async function (resolve, reject) {
  for (const cache of caches) {
    log.info("[Stats] Cache keys and TTL for " + cache.name + ":");

    cache.bucket.keys(function(err, keys){
      if (!err) {
        for (const key of keys) {
          const TTL_MS = cache.bucket.getTtl(key);
          log.info("[Stats] Key: '" + key + "', TTL: " + TTL_MS + " ms, expires at " + new Date(TTL_MS).toLocaleTimeString());
        }
      }
      else {
        reject(false);
      }
    });
  }

  resolve(true);
});

/**
 * The current cache buckets for Canvas API.
 */
exports.cacheBuckets = () => {
  return caches;
};

exports.addCacheRead = (cacheName) => {
  caches.filter(cache => {
    if (cache.name == cacheName) {
      cache.reads++;
    }
  })
};

exports.addCacheWrite = (cacheName) => {
  caches.filter(cache => {
    if (cache.name == cacheName) {
      cache.writes++;
    }
  })
};

module.exports.getCacheStat = async () => new Promise(async function (resolve, reject) {
  var cacheList = [];

  for (const cache of caches) {
    var cacheKeys = [];

    cache.bucket.keys(function(err, keys){
      if (!err) {
        for (const key of keys) {
          const TTL_MS = cache.bucket.getTtl(key);

          var thisKey = {
            name: key,
            ttl_ms: TTL_MS,
            expires_at: new Date(TTL_MS).toLocaleTimeString()
          };

          cacheKeys.push(thisKey);
        }
      }
    });

    var cacheData = {
      name: cache.name,
      reads: cache.reads,
      writes: cache.writes,
      dashboard: cache.dashboard,
      keys: cacheKeys
    };

    cacheList.push(cacheData);
  }

  resolve(cacheList);
});

/**
 * Compile category groups data for CSV export.
 */
module.exports.compileCategoryGroupsData = async (categoryId, request) => new Promise(async function(resolve, reject) {
  var hrstart = process.hrtime();
  var categoriesWithGroups = new Array();
  var groupsWithUsers = new Array();

  log.info("[API] GetCategoryGroups()");

  // Get data about each group in this category.
  await exports.getCategoryGroups(categoryId, request).then(async function (groupsData) {
    for (const group of groupsData) {
      var usersWithDetails = new Array();

      log.info("[API] GetGroupUsers()");

      // Get data about each user in the group.
      await exports.getGroupUsers(group.id, request).then(async function (usersData) {
        for (const user of usersData) {
          usersWithDetails.push({
            userId: user.id,
            name: user.name,
            sortableName: user.sortable_name,
            email: user.email,
            login_id: user.login_id,
            avatarUrl: user.avatar_url
          });
        }
      })
      .catch(function (error) {
        reject(error);
      });

      groupsWithUsers.push({ 
        id: group.id,
        name: group.name,
        description: group.description,
        category_id: group.group_category_id,
        users: usersWithDetails
      });
    }
  })
  .catch(function(error) {
    reject(error);
  });

  categoriesWithGroups.push({
    id: categoryId,
    groups: groupsWithUsers
  });

  // Measure time it took to process.
  var hrend = process.hrtime(hrstart);

  // Compile JSON that returns to view.
  let data = {
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
    categories: categoriesWithGroups,
    statistics: {
      running_s: hrend[0],
      running_ms: (hrend[1] / 1000000)
    }
  };

  resolve(data);
});

/** 
 * Compile groups data for web view.
 */
module.exports.compileGroupsData = async (canvasCourseId, request) => new Promise(async function(resolve, reject) {
  var hrstart = process.hrtime();
  var categoriesWithGroups = new Array();

  log.info("[API] GetGroupCategories()");

  await exports.getGroupCategories(canvasCourseId, request).then(async function (categoriesData) {
    for (const category of categoriesData) {
      var groupsWithUsers = new Array();

      log.info("[API] GetCategoryGroups()");

      // Get data about each group in this category.
      await exports.getCategoryGroups(category.id, request).then(async function (groupsData) {
        for (const group of groupsData) {
          var usersWithDetails = new Array();
  
          log.info("[API] GetGroupUsers()");
  
          // Get data about each user in the group.
          await exports.getGroupUsers(group.id, request).then(async function (usersData) {
            for (const user of usersData) {
              usersWithDetails.push({
                userId: user.id,
                name: user.name,
                sortableName: user.sortable_name,
                email: user.email,
                avatarUrl: user.avatar_url
              });
            }
          })
          .catch(function (error) {
            reject(error);
          });
  
          groupsWithUsers.push({ 
            id: group.id,
            name: group.name,
            description: group.description,
            category_id: group.group_category_id,
            users: usersWithDetails
          });
        }
      })
      .catch(function(error) {
        reject(error);
      });

      let self_signup = {
        enabled: category.self_signup == 'enabled' || category.self_signup == 'restricted' ? true : false,
        ruleset: []
      };

      if (self_signup.enabled) {
        self_signup.ruleset = await db.getSelfSignupConfig(canvasCourseId, category.id);
      }

      categoriesWithGroups.push({
        id: category.id,
        name: category.name,
        self_signup: self_signup,
        groups: groupsWithUsers
      });
    }
  })
  .catch(function(error) {
    reject(error);   
  });

  // Measure time it took to process.
  var hrend = process.hrtime(hrstart);

  // Compile JSON that returns to view.
  let data = {
    user: {
      fullname: request.session.fullname,
      id: request.session.userId
    },
    course: {
      id: request.session.canvasCourseId,
      contextTitle: request.session.contextTitle,
      categories: categoriesWithGroups
    },
    statistics: {
      running_s: hrend[0],
      running_ms: (hrend[1] / 1000000)
    }
  };

  await exports.cacheStat();

  log.info(JSON.stringify(data));
  resolve(data);
});

// Get groups for a specified course (NOTE: this method is actually not used).
exports.getCourseGroups = async (courseId, request) => new Promise(async function(resolve, reject) {
  try {
    const cachedData = courseGroupsCache.get(courseId);

    log.info("[Cache] Using found NodeCache entry for courseId " + courseId + ".");
    log.debug("[Cache] Statistics: " + JSON.stringify(courseGroupsCache.getStats()));

    await exports.addCacheRead('courseGroupsCache');

    resolve(cachedData);
  }
  catch (err) {
    var thisApiPath = exports.apiPath(request) + "/courses/" + courseId + "/groups?per_page=" + API_PER_PAGE;
    var apiData = [];
    var returnedApiData = [];
    var errorCount = 0;

    while (errorCount < 4 && thisApiPath && request.session.token.access_token) {
      log.info("[API] GET " + thisApiPath);

      try {
        const response = await axios.get(thisApiPath, {
          headers: {
            "User-Agent": "Chalmers/Azure/Request",
            "Authorization": request.session.token.token_type + " " + request.session.token.access_token
          }
        });
        
        const data = response.data;
        apiData.push(data);

        if (response.headers["link"]) {
          var link = LinkHeader.parse(response.headers["link"]);

          if (link.has("rel", "next")) {
            thisApiPath = link.get("rel", "next")[0].uri;
          }
          else {
            thisApiPath = false;
          }
        }
        else {
          thisApiPath = false;
        }  
      }
      catch (error) {
        errorCount++;
        log.error("[API] Error: " + error);

        if (error.response.status == 401 && error.response.headers['www-authenticate']) { // refresh token, then try again
          await oauth.providerRefreshToken(request);
        }
        else if (error.response.status == 401 && !error.response.headers['www-authenticate']) { // no access, redirect to auth
          log.error("[API] Not authorized in Canvas for use of this API endpoint.");
          log.error(JSON.stringify(error));
          reject(error);
        }
        else {
          log.error(error);
          reject(error);  
        }
      }
    }

    // Compile new object from all pages.
    // TODO: Include errorCount here in some way for GUI.
    for (const page in apiData) {
      for (const record in page) {
        returnedApiData.push(record);
      }
    }

    // Store in cache.
    courseGroupsCache.set(userId, returnedApiData);

    log.debug("[Cache] Data cached for " + CACHE_TTL / 60 + " minutes: " + JSON.stringify(returnedApiData));
    log.debug("[Cache] Statistics: " + JSON.stringify(courseGroupsCache.getStats()));
    log.debug("[Cache] Keys: " + courseGroupsCache.keys());

    await exports.addCacheWrite('courseGroupsCache');

    resolve(returnedApiData);
  }
});

// Get group categories for a specified course.
module.exports.getGroupCategories = async (courseId, request) => new Promise(async function(resolve, reject) {
  try {
    const cachedData = groupCategoriesCache.get(courseId);

    log.info("[Cache] Using found NodeCache entry for courseId " + courseId + ".");
    log.debug("[Cache] Statistics: " + JSON.stringify(groupCategoriesCache.getStats()));

    await exports.addCacheRead('groupCategoriesCache');

    resolve(cachedData);
  }
  catch {
    var thisApiPath = exports.apiPath(request) + "/courses/" + courseId + "/group_categories?per_page=" + API_PER_PAGE;
    var apiData = new Array();
    var returnedApiData = new Array();
    var errorCount = 0;

    while (errorCount < 4 && thisApiPath && request.session.token.access_token) {
      log.info("[API] GET " + thisApiPath);

      try {
        const response = await axios.get(thisApiPath, {
          headers: {
            "User-Agent": "Chalmers/Azure/Request",
            "Authorization": request.session.token.token_type + " " + request.session.token.access_token
          }
        });

        const data = response.data;
        apiData.push(data);

        if (response.headers["link"]) {
          var link = LinkHeader.parse(response.headers["link"]);

          if (link.has("rel", "next")) {
            thisApiPath = link.get("rel", "next")[0].uri;
          }
          else {
            thisApiPath = false;
          }
        }
        else {
          thisApiPath = false;
        }        
      }
      catch (error) {
        errorCount++;
        log.error("[API] Error: " + error);

        if (error.response.status == 401 && error.response.headers['www-authenticate']) { // refresh token, then try again
          await oauth.providerRefreshToken(request);
        }
        else if (error.response.status == 401 && !error.response.headers['www-authenticate']) { // no access, redirect to auth
          log.error("[API] Not authorized in Canvas for use of this API endpoint.");
          log.error(JSON.stringify(error));
          reject(error);
        }
        else {
          log.error(error);
          reject(error);  
        }
      }
    }

    // Compile new object from all pages.
    // TODO: Include errorCount in some way for GUI.
    for (const page of apiData) {
      for (const record of page) {
        returnedApiData.push(record);
      }
    }

    // Store in cache.
    groupCategoriesCache.set(courseId, returnedApiData);
    await exports.addCacheWrite('groupCategoriesCache');

    log.debug("[Cache] Data cached for " + CACHE_TTL / 60 + " minutes: " + JSON.stringify(returnedApiData));
    log.debug("[Cache] Statistics: " + JSON.stringify(groupCategoriesCache.getStats()));
    log.debug("[Cache] Keys: " + groupCategoriesCache.keys());

    resolve(returnedApiData);
  }
});

// Get groups for a specified category.
exports.getCategoryGroups = async (categoryId, request, access_token) => new Promise(async function(resolve, reject) {
  try {
    const cachedData = categoryGroupsCache.get(categoryId);

    log.info("[Cache] Using found NodeCache entry for categoryId " + categoryId + ".");
    log.debug("[Cache] Statistics: " + JSON.stringify(categoryGroupsCache.getStats()));

    await exports.addCacheRead('categoryGroupsCache');

    resolve(cachedData);
  }
  catch {
    var thisApiPath = exports.apiPath(request) + "/group_categories/" + categoryId + "/groups?per_page=" + API_PER_PAGE;
    var apiData = [];
    var returnedApiData = [];
    var errorCount = 0;

    while (errorCount < 4 && thisApiPath && (request.session?.token?.access_token || access_token)) {
      log.info("[API] GET " + thisApiPath);

      try {
        const headers = {
          "User-Agent": "Chalmers/Azure/Request",
          "Authorization": access_token ? "Bearer " + access_token : request.session.token.token_type + " " + request.session.token.access_token
        };
        
        log.info(JSON.stringify(headers));

        const response = await axios.get(thisApiPath, {
          json: true,
          headers: headers
        });

        const data = response.data;
        apiData.push(data);

        if (response.headers["link"]) {
          var link = LinkHeader.parse(response.headers["link"]);

          if (link.has("rel", "next")) {
            thisApiPath = link.get("rel", "next")[0].uri;
          }
          else {
            thisApiPath = false;
          }
        }
        else {
          thisApiPath = false;
        }
      }
      catch (error) {
        errorCount++;
        log.error("[API] Error: " + error);

        if (error.response.status == 404) {
          thisApiPath = false;
          log.error("Group category not found, possibly deleted referenced from self signup config. Returning empty data.");
        }
        else if (error.response.status == 401 && error.response.headers['www-authenticate']) { // refresh token, then try again
          await oauth.providerRefreshToken(request);
        }
        else if (error.response.status == 401 && !error.response.headers['www-authenticate']) { // no access, redirect to auth
          log.error("[API] Not authorized in Canvas for use of this API endpoint.");
          log.error(JSON.stringify(error));
          reject(error);
        }
        else {
          log.error(error);
          reject(error);  
        }
      }
    }

    // Compile new object from all pages.
    // TODO: Include errorCount in some way for GUI.
    for (const page of apiData) {
      for (const record of page) {
        returnedApiData.push(record);
      }
    }

    // Store in cache.
    categoryGroupsCache.set(categoryId, returnedApiData);
  
    log.debug("[Cache] Data cached for " + CACHE_TTL / 60 + " minutes: " + JSON.stringify(returnedApiData));
    log.debug("[Cache] Statistics: " + JSON.stringify(categoryGroupsCache.getStats()));
    log.debug("[Cache] Keys: " + categoryGroupsCache.keys());

    await exports.addCacheWrite('categoryGroupsCache');

    resolve(returnedApiData);
  }
});

// Get users (not members) for a specified group.
exports.getGroupUsers = async (groupId, request) => new Promise(async function(resolve, reject) {
  try {
    const cachedData = groupUsersCache.get(groupId);

    log.info("[Cache] Using found NodeCache entry for groupId " + groupId + ".");
    log.debug("[Cache] Statistics: " + JSON.stringify(groupUsersCache.getStats()));

    await exports.addCacheRead('groupUsersCache');

    resolve(cachedData);
  }
  catch {
    var thisApiPath = exports.apiPath(request) + "/groups/" + groupId + "/users?include[]=avatar_url&include[]=email&per_page=" + API_PER_PAGE;
    var apiData = [];
    var returnedApiData = [];
    var errorCount = 0;

    while (errorCount < 4 && thisApiPath && request.session.token.access_token) {
      log.info("[API] GET " + thisApiPath);

      try {
        const response = await axios.get(thisApiPath, {
          json: true,
          headers: {
            "User-Agent": "Chalmers/Azure/Request",
            "Authorization": request.session.token.token_type + " " + request.session.token.access_token
          }
        });

        const data = response.data;
        apiData.push(data);

        if (response.headers["link"]) {
          var link = LinkHeader.parse(response.headers["link"]);

          if (link.has("rel", "next")) {
            thisApiPath = link.get("rel", "next")[0].uri;
          }
          else {
            thisApiPath = false;
          }
        }
        else {
          thisApiPath = false;
        }
      }
      catch (error) {
        errorCount++;
        log.error("[API] Error: " + error);

        if (error.response.status == 401 && error.response.headers['www-authenticate']) { // refresh token, then try again
          await oauth.providerRefreshToken(request);
        }
        else if (error.response.status == 401 && !error.response.headers['www-authenticate']) { // no access, redirect to auth
          log.error("[API] Not authorized in Canvas for use of this API endpoint.");
          log.error(JSON.stringify(error));
          reject(error);
        }
        else {
          log.error(error);
          reject(error);  
        }
      }
    }

    // Compile new object from all pages.
    // TODO: Include errorCount in some way for GUI.
    for (const page of apiData) {
      for (const record of page) {
        returnedApiData.push(record);
      }
    }

    // Store in cache.
    groupUsersCache.set(groupId, returnedApiData);
  
    log.debug("[Cache] Data cached for " + CACHE_TTL / 60 + " minutes: " + JSON.stringify(returnedApiData));
    log.debug("[Cache] Statistics: " + JSON.stringify(groupUsersCache.getStats()));
    log.debug("[Cache] Keys: " + groupUsersCache.keys());

    await exports.addCacheWrite('groupUsersCache');

    resolve(returnedApiData);
  }
});

// Get memberships data for a specified group.
exports.getGroupMembers = async (groupId, request) => new Promise(async function(resolve, reject) {
  try {
    const cachedData = memberCache.get(groupId);

    log.info("[Cache] Using found NodeCache entry for groupId " + groupId + ".");
    log.debug("[Cache] Statistics: " + JSON.stringify(memberCache.getStats()));

    await exports.addCacheRead('memberCache');

    resolve(cachedData);
  }
  catch {
    var thisApiPath = exports.apiPath(request) + "/groups/" + groupId + "/memberships?per_page=" + API_PER_PAGE;
    var apiData = [];
    var returnedApiData = [];
    var errorCount = 0;

    while (errorCount < 4 && thisApiPath && request.session.token.access_token) {
      log.info("[API] GET " + thisApiPath);

      try {
        const response = await axios.get(thisApiPath, {
          json: true,
          headers: {
            "User-Agent": "Chalmers/Azure/Request",
            "Authorization": request.session.token.token_type + " " + request.session.token.access_token
          }
        });

        const data = response.data;
        apiData.push(data);

        if (response.headers["link"]) {
          var link = LinkHeader.parse(response.headers["link"]);

          if (link.has("rel", "next")) {
            thisApiPath = link.get("rel", "next")[0].uri;
          }
          else {
            thisApiPath = false;
          }
        }
        else {
          thisApiPath = false;
        }
      }
      catch (error) {
        errorCount++;
        log.error("[API] Error: " + error);

        if (error.response.status == 401 && error.response.headers['www-authenticate']) { // refresh token, then try again
          await oauth.providerRefreshToken(request);
        }
        else if (error.response.status == 401 && !error.response.headers['www-authenticate']) { // no access, redirect to auth
          log.error("[API] Not authorized in Canvas for use of this API endpoint.");
          log.error(JSON.stringify(error));
          reject(error);
        }
        else {
          log.error(error);
          reject(error);  
        }
      }
    }

    // Compile new object from all pages.
    // TODO: Include errorCount in some way for GUI.
    for (const page of apiData) {
      for (const record of page) {
        returnedApiData.push(record);
      }
    }

    // Store in cache.
    memberCache.set(groupId, returnedApiData);
  
    log.debug("[Cache] Data cached for " + CACHE_TTL / 60 + " minutes: " + JSON.stringify(returnedApiData));
    log.debug("[Cache] Statistics: " + JSON.stringify(memberCache.getStats()));
    log.debug("[Cache] Keys: " + memberCache.keys());

    await exports.addCacheWrite('memberCache');

    resolve(returnedApiData);
  }
});

/**
 * List assignments in course that has type "points" and are published.
 * Used by administrator/teacher to create a Group Rule.
 * 
 * @param {Number} courseId 
 * @param {Object} request 
 * @returns Valid assignments in course to use with Group Rule.
 */
exports.getCourseAssignments = async (courseId, request) => new Promise(async function(resolve, reject) {
  try {
    const cachedData = assignmentCache.get(courseId);

    log.info("[Cache] Using found NodeCache entry for courseId " + courseId + ".");
    log.debug("[Cache] Statistics: " + JSON.stringify(assignmentCache.getStats()));

    await exports.addCacheRead('assignmentCache');

    resolve(cachedData);
  }
  catch {
    var thisApiPath = exports.apiPath(request) + "/courses/" + courseId + "/assignments?per_page=" + API_PER_PAGE;
    var apiData = [];
    var returnedApiData = [];
    var errorCount = 0;

    while (errorCount < 4 && thisApiPath && request.session.token.access_token) {
      log.info("[API] GET " + thisApiPath);

      try {
        const response = await axios.get(thisApiPath, {
          json: true,
          headers: {
            "User-Agent": "Chalmers/Azure/Request",
            "Authorization": request.session.token.token_type + " " + request.session.token.access_token
          }
        });

        const data = response.data;
        apiData.push(data);

        if (response.headers["link"]) {
          var link = LinkHeader.parse(response.headers["link"]);

          if (link.has("rel", "next")) {
            thisApiPath = link.get("rel", "next")[0].uri;
          }
          else {
            thisApiPath = false;
          }
        }
        else {
          thisApiPath = false;
        }
      }
      catch (error) {
        errorCount++;
        log.error("[API] Error: " + error);

        if (error.response.status == 401 && error.response.headers['www-authenticate']) { // refresh token, then try again
          await oauth.providerRefreshToken(request);
        }
        else if (error.response.status == 401 && !error.response.headers['www-authenticate']) { // no access, redirect to auth
          log.error("[API] Not authorized in Canvas for use of this API endpoint.");
          log.error(JSON.stringify(error));
          reject(error);
        }
        else {
          log.error(error);
          reject(error);  
        }
      }
    }

    // Compile new object from all pages.
    // TODO: Include errorCount in some way for GUI.
    for (const page of apiData) {
      for (const record of page) {
        if (record.grading_type == "points" && record.published == true) {
          returnedApiData.push({
            id: record.id,
            name: record.name,
            grading_type: record.grading_type,
            points_possible: record.points_possible,
            published: record.published,
            locked_for_user: record.locked_for_user
          });
        }
      }
    }

    // Store in cache.
    assignmentCache.set(courseId, returnedApiData);
  
    log.debug("[Cache] Data cached for " + CACHE_TTL / 60 + " minutes: " + JSON.stringify(returnedApiData));
    log.debug("[Cache] Statistics: " + JSON.stringify(assignmentCache.getStats()));
    log.debug("[Cache] Keys: " + assignmentCache.keys());

    await exports.addCacheWrite('assignmentCache');

    resolve(returnedApiData);
  }
});

/**
 * Get assignment submissions and the relevant grade for a particular user.
 * Note: Uses system account rights to be able to read this information in anonymous request.
 * 
 * @param {Number} courseId 
 * @param {Number} assignmentId 
 * @param {Number} userId 
 * @param {Object} request 
 * @returns Grade and related information.
 */
exports.getAssignmentGrade = async (courseId, assignmentId, userId, request, access_token) => new Promise(async function(resolve, reject) {
  try {
    const cachedData = assignmentGradeCache.get(assignmentId);
    var returnedData = {};

    log.info("[Cache] Using found NodeCache entry for assignmentId " + assignmentId + ".");
    log.debug("[Cache] Statistics: " + JSON.stringify(assignmentGradeCache.getStats()));

    await exports.addCacheRead('assignmentGradeCache');

    for (const entry of cachedData) {
      if (entry.user_id == userId) {
        returnedData = entry;
      }
    }

    resolve(returnedData);
  }
  catch {
    var thisApiPath = exports.apiPath(request) + "/courses/" + courseId + "/assignments/" + assignmentId + "/submissions?per_page=" + API_PER_PAGE;
    var apiData = [];
    var cachedApiData = [];
    var returnedApiData = {};
    var errorCount = 0;

    while (errorCount < 4 && thisApiPath && (request.session?.token?.access_token || access_token)) {
      log.info("[API] GET " + thisApiPath);

      try {
        const headers = {
          "User-Agent": "Chalmers/Azure/Request",
          "Authorization": access_token ? "Bearer " + access_token : request.session.token.token_type + " " + request.session.token.access_token
        };
        
        log.info(JSON.stringify(headers));

        const response = await axios.get(thisApiPath, {
          json: true,
          headers: headers
        });

        const data = response.data;
        apiData.push(data);

        if (response.headers["link"]) {
          var link = LinkHeader.parse(response.headers["link"]);

          if (link.has("rel", "next")) {
            thisApiPath = link.get("rel", "next")[0].uri;
          }
          else {
            thisApiPath = false;
          }
        }
        else {
          thisApiPath = false;
        }
      }
      catch (error) {
        errorCount++;
        log.error("[API] Error: " + error);

        if (error.response.status == 401 && error.response.headers['www-authenticate']) { // refresh token, then try again
          await oauth.providerRefreshToken(request);
        }
        else if (error.response.status == 401 && !error.response.headers['www-authenticate']) { // no access, redirect to auth
          log.error("[API] Not authorized in Canvas for use of this API endpoint.");
          log.error(JSON.stringify(error));
          reject(error);
        }
        else {
          log.error(error);
          reject(error);  
        }
      }
    }

    // Compile new object from all pages.
    for (const page of apiData) {
      for (const record of page) {
        cachedApiData.push({
          user_id: record.user_id,
          workflow_state: record.workflow_state,
          submitted_at: record.submitted_at,
          score: record.score,
          entered_score: record.entered_score
        });
      }
    }

    // Store in cache.
    assignmentGradeCache.set(assignmentId, cachedApiData);
  
    log.debug("[Cache] Data cached for " + CACHE_TTL / 60 + " minutes: " + JSON.stringify(cachedApiData));
    log.debug("[Cache] Statistics: " + JSON.stringify(assignmentGradeCache.getStats()));
    log.debug("[Cache] Keys: " + assignmentGradeCache.keys());

    await exports.addCacheWrite('assignmentGradeCache');

    for (const entry of cachedApiData) {
      if (entry.user_id == userId) {
        returnedApiData = entry;
      }
    }

    resolve(returnedApiData);
  }
});


// Get details about one specified user.
exports.getUser = async (userId, request) => new Promise(async function(resolve, reject) {
  try {
    const cachedData = userCache.get(userId);
    log.info("[Cache] Using found NodeCache entry for userId " + userId + ".");
    await exports.addCacheRead('userCache');

    resolve(cachedData);
  }
  catch {
    var thisApiPath = exports.apiPath(request) + "/users/" + userId;
    var apiData = [];
    var errorCount = 0;

    while (errorCount < 0 && thisApiPath && request.session.token.access_token) {
      log.info("[API] GET " + thisApiPath);

      try {
        const response = await axios.get(thisApiPath, {
          json: true,
          headers: {
            "User-Agent": "Chalmers/Azure/Request",
            "Authorization": request.session.token.token_type + " " + request.session.token.access_token
          }
        });

        const data = response.data;
        apiData.push(data);

        if (response.headers["link"]) {
          var link = LinkHeader.parse(response.headers["link"]);

          if (link.has("rel", "next")) {
            thisApiPath = link.get("rel", "next")[0].uri;
          }
          else {
            thisApiPath = false;
          }
        }
        else {
          thisApiPath = false;
        }
      }
      catch (error) {
        errorCount++;
        log.error("[API] Error: " + error);

        if (error.response.status == 401 && error.response.headers['www-authenticate']) { // refresh token, then try again
          await oauth.providerRefreshToken(request);
        }
        else if (error.response.status == 401 && !error.response.headers['www-authenticate']) { // no access, redirect to auth
          log.error("[API] Not authorized in Canvas for use of this API endpoint.");
          log.error(JSON.stringify(error));
          reject(error);
        }
        else {
          log.error(error);
          reject(error);  
        }
      }
    }

    userCache.set(userId, apiData[0]);

    log.debug("[Cache] Data cached for " + CACHE_TTL / 60 + " minutes: " + JSON.stringify(apiData[0]));
    log.debug("[Cache] Statistics: " + JSON.stringify(userCache.getStats()));
    log.debug("[Cache] Keys: " + userCache.keys());

    await exports.addCacheWrite('userCache');

    resolve(apiData[0]);
  }
});


exports.clearCourseCache = async (courseId, request) => new Promise(async function(resolve, reject) {
  let totalDeletedEntries = 0;

  try 
  {
    await exports.getGroupCategories(courseId, request).then(async function (categoriesData) {
      for (const category of categoriesData) {
        await exports.getCategoryGroups(category.id, request).then(async function (groupsData) {
          for (const group of groupsData) {
            const items = groupUsersCache.del(group.id);
            totalDeletedEntries = totalDeletedEntries + items;

            log.info(`[Cache] Deleted ${items} NodeCache key in groupUsersCache id ${group.id}, courseId ${courseId}.`);
          }
        });
        const items = categoryGroupsCache.del(category.id);
        totalDeletedEntries = totalDeletedEntries + items;

        log.info(`[Cache] Deleted ${items} NodeCache key in categoryGroupsCache id ${category.id}, courseId ${courseId}.`);
      }
    });

    const items = groupCategoriesCache.del(courseId);
    totalDeletedEntries = totalDeletedEntries + items;

    log.info(`[Cache] Deleted ${items} NodeCache key for groupCategoriesCache id ${courseId}, in total ${totalDeletedEntries} entries in dependent caches.`);

    resolve();
  }
  catch (error) {
    log.error(`[Cache] Error: ${error} when deleting NodeCache entries for courseId ${courseId}.`);
    reject(error);
  }
});