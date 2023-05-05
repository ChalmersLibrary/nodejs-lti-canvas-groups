'use strict';

require('dotenv').config();
const LinkHeader = require('http-link-header');
const NodeCache = require('node-cache');
const axios = require('axios');
const oauth = require('../oauth');
const log = require('../log');

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

let caches = [
  {
    name: "courseGroupsCache",
    writes: 0,
    reads: 0,
    bucket: courseGroupsCache
  },
  {
    name: "groupCategoriesCache",
    writes: 0,
    reads: 0,
    bucket: groupCategoriesCache
  },
  {
    name: "groupUsersCache",
    writes: 0,
    reads: 0,
    bucket: groupUsersCache
  },
  {
    name: "categoryGroupsCache",
    writes: 0,
    reads: 0,
    bucket: categoryGroupsCache
  },
  {
    name: "memberCache",
    writes: 0,
    reads: 0,
    bucket: memberCache
  }
  ,
  {
    name: "userCache",
    writes: 0,
    reads: 0,
    bucket: userCache
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
  log.info("[Cache] Expired NodeCache entry for userCachekey '" + key + "'.");
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
    else if (request.session.canvasApiDomain) {
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

      categoriesWithGroups.push({
        id: category.id,
        name: category.name,
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

  resolve(data);
});

// Get groups for a specified course.
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
exports.getGroupCategories = async (courseId, request) => new Promise(async function(resolve, reject) {
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
exports.getCategoryGroups = async (categoryId, request) => new Promise(async function(resolve, reject) {
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
