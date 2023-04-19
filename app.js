'use strict';

const pkg = require('./package.json');
const bodyParser = require('body-parser');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const helmet = require('helmet');
const oauth = require('./oauth');
const canvas = require('./canvas');
const lti = require('./lti');
const log = require('./log');
const db = require('./db');
const error = require('./error');

const port = process.env.PORT || 3000;
const cookieMaxAge = 3600000 * 12; // 12h
const fileStoreOptions = { ttl: 3600 * 12, retries: 3, logFn: log.info };

const adminUserIds = process.env.adminCanvasUserIds ? process.env.adminCanvasUserIds.split(",") : "";

const NODE_MAJOR_VERSION = process.versions.node.split('.')[0];
const NODE_MINOR_VERSION = process.versions.node.split('.')[1];

// this express server should be secured/hardened for production use
const app = express();

// secure express server
app.use(helmet({
    frameguard: false
}));

app.disable('X-Powered-By');

// set view engine
app.set('view engine', 'pug');

// memory store shouldn't be used in production
app.use(session({
    store: new FileStore(fileStoreOptions),
    secret: process.env.SESSION_SECRET || 'c8Vbe1',
    name: 'ltiSession',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { sameSite: 'none', secure: true, httpOnly: false, maxAge: cookieMaxAge }
}));

// parse application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: false }));

app.set('json spaces', 2);
app.enable('trust proxy');

// Development, in Azure it's set via XML config?
app.use("/assets", express.static(__dirname + '/public/assets'));

app.get('/', (request, response) => {
    return response.send({
        status: 'up',
        version: pkg.version,
        node: process.version
    });
});

app.get('/json/stats', async(request, response) => {
    if (request.session.userId) {
        if (adminUserIds.length && adminUserIds.includes(request.session.userId)) {
            const authorizedUsers = await db.getAllClientsData();
            const cacheContents = await canvas.getCacheStat();

            let now = new Date();
            var activeUsersToday = 0;
            let cacheStats = [];

            authorizedUsers.forEach(user => {
                if (user.updated_at.substr(0, 10) == now.toISOString().substr(0, 10)) {
                    activeUsersToday++;
                }
            });

            cacheContents.forEach(cache => {
                cacheStats.push({ name: cache.name, reads: cache.reads, writes: cache.writes });
            });

            return response.send({
                version: pkg.version,
                authorized_users: authorizedUsers.length,
                active_users_today: activeUsersToday,
                cache_stats: cacheStats
            });
        } else {
            log.error("Not in admin list.");
            return response.redirect('/error/code/42'); // Admin level needed
        }
    } else {
        log.error("No session found.");
        return response.redirect('/error/code/41'); // Third-party cookies
    }
});

app.get('/dashboard', async(request, response) => {
    if (request.session.userId) {
        if (adminUserIds.length && adminUserIds.includes(request.session.userId)) {
            return response.render('dashboard', {
                statistics: {
                    name: pkg.name,
                    version: pkg.version,
                    app_env: canvas.providerEnvironment(request),
                    node: process.version,
                    pid: process.pid,
                    ppid: process.ppid,
                    resourceUsage: NODE_MAJOR_VERSION >= 12 && NODE_MINOR_VERSION >= 6 ? JSON.stringify(process.resourceUsage(), null, 2) : 'Needs node 12.6',
                    versions: JSON.stringify(process.versions, null, 2)
                }
            });
        } else {
            log.error("Not in admin list.");
            return response.redirect('/error/code/42'); // Admin level needed
        }
    } else {
        log.error("No session found.");
        return response.redirect('/error/code/41'); // Third-party cookies
    }
});

app.get('/test/sqlite3', async (request, response) => {
    if (request.session.userId && adminUserIds.length && adminUserIds.includes(request.session.userId)) {
        const mocked_users = await db.getAllClientsDataMocked();

        for (const user of mocked_users) {
            await db.setClientData(user.user_id, user.user_env, user.api_token, user.refresh_token, user.expires_at);
        }
    
        const db_single_user = await db.getClientData('abcdef_123456', 'test');
        const db_users = await db.getAllClientsData();
    
        return response.send({
            success: true,
            users: {
                mocked: mocked_users,
                db: db_users,
                single: db_single_user,
            }
        });    
    }
    else {
        log.error("Not in admin list.");
        return response.redirect('/error/code/42'); // Admin level needed
    }
});

app.get('/test/cache/reads', async(request, response) => {
    let caches1 = canvas.cacheBuckets();
    log.info("Before adding cache read: " + caches1.find(obj => obj.name === 'groupCategoriesCache').reads);
    canvas.addCacheRead('groupCategoriesCache');

    let caches2 = canvas.cacheBuckets();
    log.info("After adding cache read: " + caches2.find(obj => obj.name === 'groupCategoriesCache').reads);

    return response.send({
        success: true
    });
});

app.get('/test/cache/writes', async(request, response) => {
    let caches1 = canvas.cacheBuckets();
    const caches1_writes = caches1.find(obj => obj.name === 'groupCategoriesCache').writes;
    log.info("Before adding cache write: " + caches1_writes);

    await canvas.addCacheWrite('groupCategoriesCache');

    let caches2 = canvas.cacheBuckets();
    const caches2_writes = caches2.find(obj => obj.name === 'groupCategoriesCache').writes;
    log.info("After adding cache write: " + caches2_writes);

    return response.send({
        success: true,
        before_write: caches1_writes,
        after_write: caches2_writes
    });
});

app.get('/oauth', (request, response, next) => {
    try {
        return response.redirect(oauth.providerLogin(request));
    } catch (error) {
        next(error);
    }
});

app.get('/oauth/redirect', async(request, response) => {
    try {
        request.session.token = await oauth.providerRequestToken(request);
        log.info("[Main] Written data to session: " + JSON.stringify(request.session.token));
        log.info("[Main] Redirecting to /loading/groups");
        response.redirect('/loading/groups');
    } catch (error) {
        log.error("During OAuth token exchange: " + error);
        response.redirect('/error/text/During OAuth token exchange: ' + error);
    }
});

app.get('/error/code/:id', async(request, response) => {
    return response.render('error', {
        error: {
            text: await error.errorDescription(request.params.id)
        },
        statistics: {
            name: pkg.name,
            version: pkg.version,
            app_env: canvas.providerEnvironment(request),
            node: process.version,
            pid: process.pid,
            ppid: process.ppid,
            resourceUsage: NODE_MAJOR_VERSION >= 12 && NODE_MINOR_VERSION >= 6 ? JSON.stringify(process.resourceUsage(), null, 2) : 'Needs node 12.6',
            versions: JSON.stringify(process.versions, null, 2)
        }
    });
});

app.get('/error/text/:text', (request, response) => {
    return response.render('error', {
        error: {
            text: request.params.text
        },
        statistics: {
            name: pkg.name,
            version: pkg.version,
            app_env: canvas.providerEnvironment(request),
            node: process.version,
            pid: process.pid,
            ppid: process.ppid,
            resourceUsage: NODE_MAJOR_VERSION >= 12 && NODE_MINOR_VERSION >= 6 ? JSON.stringify(process.resourceUsage(), null, 2) : 'Needs node 12.6',
            versions: JSON.stringify(process.versions, null, 2)
        }
    });
});

app.get('/stats', async(request, response) => {
    if (request.session.userId) {
        if (adminUserIds.length && adminUserIds.includes(request.session.userId)) {
            const authorizedUsers = await db.getAllClientsData();
            const cacheContents = await canvas.getCacheStat();

            return response.render('stats', {
                users: authorizedUsers,
                usersString: JSON.stringify(authorizedUsers, null, 2),
                caches: cacheContents,
                cachesString: JSON.stringify(cacheContents, null, 2),
                statistics: {
                    name: pkg.name,
                    version: pkg.version,
                    app_env: canvas.providerEnvironment(request),
                    pid: process.pid,
                    ppid: process.ppid,
                    resourceUsage: NODE_MAJOR_VERSION >= 12 && NODE_MINOR_VERSION >= 6 ? JSON.stringify(process.resourceUsage(), null, 2) : 'Needs node 12.6',
                    versions: JSON.stringify(process.versions, null, 2)
                }
            });
        } else {
            log.error("Not in admin list.");
            return response.redirect('/error/code/42'); // Admin level needed
        }
    } else {
        log.error("No session found.");
        return response.redirect('/error/code/41'); // Third-party cookies
    }
});

app.get('/loading/:page', async(request, response) => {
    return response.render('loading', { page: request.params.page });
});

app.get('/groups', async(request, response, next) => {
    if (request.session.userId && request.session.canvasCourseId) {
        try {
            const data = await canvas.compileGroupsData(request.session.canvasCourseId, request);
            data.statistics.name = pkg.name;
            data.statistics.version = pkg.version;
            data.statistics.app_env = canvas.providerEnvironment(request);

            return response.render('groups', data);
        } catch (error) {
            log.error(error);

            if (error.response.status == 401) {
                try {
                    return response.redirect(oauth.providerLogin());
                } catch (error) {
                    next(error);
                }
            } else {
                next(new Error(error));
            }
        }
    } else {
        log.error("No session found.");
        return response.redirect('/error/code/41'); // Third-party cookies
    }
});

app.get('/csv/category/:id/:name', async(request, response, next) => {
    if (request.session.userId && request.session.canvasCourseId) {
        try {
            const id = request.params.id;
            const name = request.params.name;

            if (id > 0) {
                const data = await canvas.compileCategoryGroupsData(id, request);

                response.setHeader("Content-Disposition", "attachment; filename=Canvas Groups " + name.replace(/[^a-zA-Z0-9\s]+/g, "-").replace(/[\-]+$/, "") + ".csv");
                response.set("Content-Type", "text/csv");

                let csvData = "\ufeffGroup;Student;Email address\r\n";

                for (const group of data.categories[0].groups) {
                    for (const user of group.users) {
                        csvData = csvData + "\"" + group.name + "\";\"" + user.sortableName + "\";\"" + user.email + "\"\r\n";
                    }
                }

                return response.status(200).end(csvData);
            } else {
                throw (new Error("Category id missing."));
            }
        } catch (error) {
            next(new Error(error));
        }
    } else {
        return response.redirect('/error/code/41'); // Third-party cookies
    }
});

app.get('/csv/zoom/category/:id/:name', async(request, response, next) => {
    if (request.session.userId && request.session.canvasCourseId) {
        try {
            const id = request.params.id;
            const name = request.params.name;

            if (id > 0) {
                const data = await canvas.compileCategoryGroupsData(id, request);

                response.setHeader("Content-Disposition", "attachment; filename=Zoom Breakout Rooms from Canvas " + name.replace(/[^a-zA-Z0-9\s]+/g, "-").replace(/[\-]+$/, "") + ".csv");
                response.set("Content-Type", "text/csv");

                let csvData = "Pre-assign Room Name,Email Address\r\n";

                for (const group of data.categories[0].groups) {
                    for (const user of group.users) {
                        csvData = csvData + group.name + "," + (user.email.includes("student.chalmers") ? user.login_id.split("@")[0] + "@student.chalmers.se" : user.login_id) + "\r\n";
                    }
                }

                return response.status(200).end(csvData);
            } else {
                throw (new Error("Category id missing."));
            }
        } catch (error) {
            next(new Error(error));
        }
    } else {
        return response.redirect('/error/code/41'); // Third-party cookies
    }
});

app.post('/launch_lti', lti.handleLaunch('loading/groups'));
app.post('/launch_lti_stats', lti.handleLaunch('loading/dashboard'));

app.listen(port, () => log.info(`[Main] Application listening on port ${port}.`));

process.on('uncaughtException', (err) => {
    console.error('[Main] There was an uncaught error', err);
    process.exit(1); //mandatory (as per the Node docs)
});