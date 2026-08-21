'use strict';

require('dotenv').config({ quiet: true });
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const cors = require('cors');
const pkg = require('./package.json');
const SqliteSessionStore = require('./session-store');
const oauth = require('./oauth');
const canvas = require('./canvas');
const lti = require('./lti');
const log = require('./log');
const db = require('./db');
const error = require('./error');

const port = process.env.PORT || 3000;
const cookieMaxAge = 3600000 * 12; // 12h

const adminUserIds = process.env.adminCanvasUserIds ? process.env.adminCanvasUserIds.split(",") : [];

/* The pages that /loading may send the browser on to. Without this the route is an open */
/* redirect, since it renders a meta refresh to whatever is in the path.                 */
const loadingPages = new Set(['groups', 'dashboard', 'stop']);

const app = express();

app.use(helmet({
    /* The tool runs in an iframe inside Canvas. */
    frameguard: false
}));

app.disable('x-powered-by');
app.set('view engine', 'pug');
app.set('json spaces', 2);
app.use(cors());
app.use(express.json());

/* extended: false keeps the flat body that the LTI launch signature is built from. */
app.use(express.urlencoded({ extended: false }));

/* Static assets are served before the session middleware. Every request that passes  */
/* through it touches the session, and the assets on a page are requested in parallel */
/* with each other and with the page itself.                                          */
app.use("/assets", express.static(__dirname + '/public/assets'));

/* Local development against mock-lti.json, rather than a launch from Canvas. */
const localMockSession = process.env.NODE_ENV === 'development' && Boolean(process.env.localCanvasDeveloperToken);

/**
 * The tool normally runs in an iframe inside Canvas, where only a SameSite=None cookie is
 * sent at all, and browsers reject a SameSite=None cookie that is not also Secure. Secure
 * in turn needs https, since express-session will not put a Secure cookie on a connection
 * it does not consider https.
 *
 * Local development with mock-lti.json is the one case with neither an iframe nor https: the
 * tool is opened directly in a browser, which is a first-party context, so a Lax cookie is
 * both sufficient and the only kind that can be stored over http. Without this the cookie is
 * dropped on every request, and since the mocked session is rebuilt each time it still works
 * but writes a new session row for every page load.
 */
const sessionCookie = localMockSession
    ? { maxAge: cookieMaxAge, sameSite: 'lax', secure: false }
    : { maxAge: cookieMaxAge, sameSite: 'none', secure: true };

const sessionOptions = {
    store: new SqliteSessionStore({ ttlSeconds: cookieMaxAge / 1000 }),
    name: process.env.SESSION_NAME ? process.env.SESSION_NAME : "groupTool.sid",
    secret: process.env.SESSION_SECRET ? process.env.SESSION_SECRET : "keyboard cat fish mouse",
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: sessionCookie
};

if (localMockSession) {
    log.info('[Main] Local development with mock-lti.json: first-party session cookie (SameSite=Lax, not Secure).');
}

/* Trust the x-forwarded-* headers. Always on in production, where the Azure front end
   terminates https, and settable on its own for local development behind a tunnel: without
   it the application sees http and its own host, which makes the LTI launch signature fail
   however correct the shared secret is. */
if (process.env.trustProxy === 'true' && process.env.NODE_ENV !== "production") {
    app.set('trust proxy', 1);
    log.info('[Main] trust proxy is on, x-forwarded-proto and x-forwarded-host are honoured.');
}

if (process.env.NODE_ENV === "production") {
    app.set('trust proxy', 1);

    /* The tool only ever runs in an iframe inside Canvas, so its cookie is a third party
       cookie. Browsers are restricting those unless they are partitioned to the embedding
       site, which is what Partitioned asks for (CHIPS). Without it the launch stops working
       as the restrictions tighten. A partitioned cookie must also be Secure, which is why
       this sits here rather than with the options above.

       Note that this deliberately ties the session to the Canvas page it was created under:
       opening a tool url directly in a tab is a different partition and has no session. */
    sessionOptions.cookie.partitioned = true;
}

app.use(session(sessionOptions));

// Content Security Policy Header
app.use(function (req, res, next) {
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' cdn.jsdelivr.net maxcdn.bootstrapcdn.com ajax.googleapis.com unpkg.com; style-src 'self' 'unsafe-inline' cdn.jsdelivr.net maxcdn.bootstrapcdn.com fonts.googleapis.com; font-src 'self' cdn.jsdelivr.net fonts.gstatic.com fonts.googleapis.com; img-src 'self' data:; frame-src 'self'" + (process.env.CSP_FRAME_SRC_ALLOW ? " " + process.env.CSP_FRAME_SRC_ALLOW : "")
    );

    res.setHeader(
        'Access-Control-Allow-Origin', '*'
    );

    next();
});

// Mock local session
app.use(function (req, res, next) {
    if (localMockSession) {
        lti.mockLocalSession(req);
    }

    next();
});

/**
 * The runtime facts that every view footer shows.
 */
const appStatistics = (request) => ({
    name: pkg.name,
    version: pkg.version,
    app_env: canvas.providerEnvironment(request),
    node: process.version,
    pid: process.pid,
    ppid: process.ppid,
    resourceUsage: JSON.stringify(process.resourceUsage(), null, 2),
    versions: JSON.stringify(process.versions, null, 2)
});

/**
 * Requires a session. Everything below the LTI launch needs one, and without it the only
 * useful thing to say is that third-party cookies have to be allowed.
 */
const requireSession = (request, response, next) => {
    if (!request.session.userId) {
        log.error("No session found.");

        return response.redirect('/error/code/41'); // Third-party cookies
    }

    next();
};

/**
 * Requires the user to be one of the listed administrators.
 */
const requireAdmin = (request, response, next) => {
    if (!adminUserIds.length || !adminUserIds.includes(request.session.userId)) {
        log.error("Not in admin list.");

        return response.redirect('/error/code/42'); // Admin level needed
    }

    next();
};

/**
 * Requires a session that has been through an LTI launch in a course.
 */
const requireCourse = (request, response, next) => {
    if (!request.session.userId || !request.session.canvasCourseId) {
        log.error("No session found.");

        return response.redirect('/error/code/41'); // Third-party cookies
    }

    next();
};

app.get('/', (request, response) => {
    return response.send({
        status: 'up',
        version: pkg.version,
        node: process.version
    });
});

app.get('/json/stats', requireSession, requireAdmin, async (request, response) => {
    const authorizedUsers = await db.getAllClientsData();
    const selfSignupConfig = await db.getAllSelfSignupConfigData();
    const today = new Date().toISOString().substring(0, 10);

    return response.send({
        version: pkg.version,
        authorized_users: authorizedUsers.length,
        active_users_today: authorizedUsers.filter((user) => user.updated_at.substring(0, 10) == today).length,
        self_signup_configs: selfSignupConfig.length,
        cache_stats: canvas.getCacheStat()
            .filter((cache) => cache.dashboard)
            .map((cache) => ({ name: cache.name, reads: cache.reads, writes: cache.writes }))
    });
});

app.get('/dashboard', requireSession, requireAdmin, (request, response) => {
    return response.render('dashboard', {
        statistics: appStatistics(request)
    });
});

app.get('/stats', requireSession, requireAdmin, async (request, response) => {
    const authorizedUsers = await db.getAllClientsData();
    const cacheContents = canvas.getCacheStat();

    return response.render('stats', {
        users: authorizedUsers,
        usersString: JSON.stringify(authorizedUsers, null, 2),
        caches: cacheContents,
        cachesString: JSON.stringify(cacheContents, null, 2),
        statistics: appStatistics(request)
    });
});

app.get('/test/sqlite3', requireSession, requireAdmin, async (request, response) => {
    const mockedUsers = db.getAllClientsDataMocked();

    for (const user of mockedUsers) {
        await db.setClientData(user.user_id, user.user_env, user.api_token, user.refresh_token, user.expires_at);
    }

    const single = await db.getClientData('abcdef_123456', 'test');

    return response.send({
        success: true,
        users: {
            mocked: mockedUsers,
            db: await db.getAllClientsData(),
            /* getClientData returns the real token, since that is what it is for elsewhere. */
            single: single && {
                ...single,
                access_token: db.tokenFingerprint(single.access_token),
                refresh_token: db.tokenFingerprint(single.refresh_token)
            }
        }
    });
});

app.get('/oauth', (request, response) => {
    return response.redirect(oauth.providerLogin(request));
});

app.get('/oauth/redirect', async (request, response) => {
    try {
        request.session.token = await oauth.providerRequestToken(request);

        log.info("[Main] Written token data to session, expires: " + request.session.token.expires_at_utc);
        log.info("[Main] Redirecting to /loading/groups");

        return response.redirect('/loading/groups');
    }
    catch (err) {
        log.error("During OAuth token exchange: " + err);

        return response.redirect('/error/text/' + encodeURIComponent('During OAuth token exchange: ' + err.message));
    }
});

app.get('/error/code/:id', (request, response) => {
    return response.render('error', {
        error: {
            text: error.errorDescription(request.params.id)
        },
        statistics: appStatistics(request)
    });
});

app.get('/error/text/:text', (request, response) => {
    return response.render('error', {
        error: {
            text: request.params.text
        },
        statistics: appStatistics(request)
    });
});

app.get('/loading/:page', (request, response) => {
    if (!loadingPages.has(request.params.page)) {
        return response.redirect('/error/code/20');
    }

    return response.render('loading', { page: request.params.page });
});

/**
 * General user interface for viewing and downloading csv files, plus configuring Self signup rules.
 */
app.get('/groups', requireCourse, async (request, response, next) => {
    try {
        const data = await canvas.compileGroupsData(request.session.canvasCourseId, request);

        data.statistics = { ...data.statistics, ...appStatistics(request) };
        data.user.isAdmin = adminUserIds.length > 0 && adminUserIds.includes(request.session.userId);

        return response.render('groups', data);
    }
    catch (err) {
        log.error(err);

        if (err.name == 'NoSessionTokenError' || err.name == 'ReauthorizationNeededError' || err.response?.status == 401) {
            log.info("[Session] " + err.message + " Forcing OAuth flow.");

            return response.redirect('/oauth');
        }

        return next(err);
    }
});

/**
 * Public API used by Canvas injected custom js to get information on self signup
 * and submissions to configured assignment for a specific user.
 */
app.get('/api/self-signup/:course_id/:user_id', async (request, response) => {
    const { course_id: courseId, user_id: userId } = request.params;

    try {
        const assignments = await db.getSelfSignupConnectedAssignments(courseId);
        const groupData = [];

        for (const assignment of assignments) {
            const [groups, userSubmission] = await Promise.all([
                canvas.getCategoryGroups(assignment.group_category_id, request, process.env.systemApiToken),
                canvas.getAssignmentGrade(courseId, assignment.assignment_id, userId, request, process.env.systemApiToken)
            ]);

            for (const group of groups) {
                groupData.push({
                    id: group.id,
                    name: group.name,
                    passed: userSubmission.score >= assignment.min_points,
                    description: assignment.description,
                    debug: userSubmission
                });
            }
        }

        log.info(`[SelfSignupPublicApi] Course id ${courseId} user id ${userId} returned ${groupData.length} group(s).`);

        return response.json({ success: true, groups: groupData });
    }
    catch (err) {
        log.error(`[SelfSignupPublicApi] Course id ${courseId} user id ${userId}: ${err}`);

        return response.json({ success: false, groups: [] });
    }
});

/**
 * API for deleting a ruleset.
 */
app.delete('/api/config/self-signup/:id', requireCourse, async (request, response) => {
    try {
        await db.clearSelfSignupConfig(request.session.canvasCourseId, request.params.id);

        log.info(`[SelfSignupConfig] Course id ${request.session.canvasCourseId} rule id ${request.params.id} cleared.`);

        return response.send({
            success: true,
            message: "Self signup rule cleared."
        });
    }
    catch (err) {
        log.error(err);

        return response.send({
            success: false,
            message: err.message
        });
    }
});

/**
 * API for creating or updating a ruleset.
 */
app.put('/api/config/self-signup/:id', requireCourse, async (request, response) => {
    const { assignment_id, description, min_points } = request.body;

    try {
        await db.setSelfSignupConfig(request.session.canvasCourseId, request.params.id, assignment_id, description, min_points);

        const writtenData = await db.getSelfSignupConfig(request.session.canvasCourseId, request.params.id);

        log.info(`[SelfSignupConfig] Course id ${request.session.canvasCourseId} rule id ${request.params.id} created/updated.`);

        return response.send({
            success: true,
            message: "Rule was created or updated.",
            written_data: writtenData
        });
    }
    catch (err) {
        log.error(err);

        return response.send({
            success: false,
            message: err.message
        });
    }
});

/* The category name is a wildcard because it may contain a slash. In Express 5 that is */
/* *name, and the matched segments arrive as an array.                                   */
app.get('/api/config/self-signup/:id/*name', requireCourse, async (request, response, next) => {
    try {
        const categoryName = [].concat(request.params.name).join('/');

        return response.json({
            course: {
                id: request.session.canvasCourseId
            },
            category: {
                id: request.params.id,
                name: categoryName
            },
            current: await db.getSelfSignupConfig(request.session.canvasCourseId, request.params.id),
            assignments: await canvas.getCourseAssignments(request.session.canvasCourseId, request)
        });
    }
    catch (err) {
        log.error(err);

        if (err.name == 'NoSessionTokenError' || err.name == 'ReauthorizationNeededError' || err.response?.status == 401) {
            return response.redirect('/oauth');
        }

        return next(err);
    }
});

/**
 * API for clearing the caches for a course
 */
app.get('/api/config/clear-cache/:course_id', async (request, response) => {
    if (!request.session.userId) {
        log.error("No session found.");

        return response.send({
            success: false,
            message: "No session, you must enable third-party cookies."
        });
    }

    const deletedEntries = await canvas.clearCourseCache(request.params.course_id, request);

    return response.send({
        success: true,
        deleted_entries: deletedEntries
    });
});

/**
 * Group members of one category as csv, in the two flavours that are asked for.
 */
const csvExports = {
    groups: {
        filename: (name) => `Canvas Groups ${name}.csv`,
        header: "﻿Group;Student;Email address\r\n",
        row: (group, user) => `"${group.name}";"${user.sortableName}";"${user.email}"\r\n`
    },
    zoom: {
        filename: (name) => `Zoom Breakout Rooms from Canvas ${name}.csv`,
        header: "Pre-assign Room Name,Email Address\r\n",
        row: (group, user) => `${group.name},${user.email.includes("student.chalmers") ? user.login_id.split("@")[0] + "@student.chalmers.se" : user.login_id}\r\n`
    }
};

const sendCategoryCsv = (flavour) => async (request, response, next) => {
    try {
        const { id, name } = request.params;

        if (!(id > 0)) {
            throw new Error("Category id missing.");
        }

        const data = await canvas.compileCategoryGroupsData(id, request);
        const safeName = name.replace(/[^a-zA-Z0-9\s]+/g, "-").replace(/-+$/, "");

        response.setHeader("Content-Disposition", `attachment; filename="${flavour.filename(safeName)}"`);
        response.set("Content-Type", "text/csv");

        let csvData = flavour.header;

        for (const group of data.categories[0].groups) {
            for (const user of group.users) {
                csvData += flavour.row(group, user);
            }
        }

        return response.status(200).end(csvData);
    }
    catch (err) {
        return next(err);
    }
};

app.get('/csv/category/:id/:name', requireCourse, sendCategoryCsv(csvExports.groups));
app.get('/csv/zoom/category/:id/:name', requireCourse, sendCategoryCsv(csvExports.zoom));

app.post('/launch_lti', lti.handleLaunch('loading/groups'));
app.post('/launch_lti_stats', lti.handleLaunch('loading/dashboard'));

/* Anything that reaches here has not been handled, so render the error page instead of */
/* the stack trace that Express would otherwise send to the browser.                    */
app.use((err, request, response, next) => {
    log.error('[Main] Unhandled request error: ' + (err.stack ?? err));

    if (response.headersSent) {
        return next(err);
    }

    return response.status(err.status ?? 500).render('error', {
        error: {
            text: process.env.NODE_ENV === 'production' ? 'Something went wrong. Please try again or contact Canvas support if the problem persists.' : String(err.message ?? err)
        },
        statistics: appStatistics(request)
    });
});

const server = app.listen(port, () => log.info(`[Main] Application listening on port ${port}, node ${process.version}.`));

/* Exported so that a test can start the application and shut it down again. */
module.exports = { app, server };

/* A rejected promise that no one handles must not take the application down for */
/* every user; it only concerns the request that caused it.                      */
process.on('unhandledRejection', (reason) => {
    log.error('[Main] Unhandled promise rejection: ' + (reason?.stack ?? reason));
});

process.on('uncaughtException', (err) => {
    console.error('[Main] There was an uncaught error', err);
    process.exit(1); //mandatory (as per the Node docs)
});
