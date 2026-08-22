'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const log = require('../log');

/**
 * A short, stable fingerprint of a token, for the pages that report on stored tokens.
 *
 * An access token is a credential and a refresh token is a long lived one that gives full
 * API access as the user, so neither belongs on a page or in a log. What those pages are
 * for is telling whether a token has changed since last time, and a hash answers that just
 * as well as the value does, without being usable if the page is left open or copied.
 */
const tokenFingerprint = (token) => {
    if (!token) {
        return null;
    }

    const value = String(token);

    return `sha256:${crypto.createHash('sha256').update(value).digest('hex').slice(0, 12)} (${value.length} chars)`;
};

/* The path can be pointed somewhere else with DB_PATH, so that a test run does not write */
/* into the database that is being developed against. An empty DB_PATH counts as unset:   */
/* it is what a copied .env leaves behind, and ?? would keep the empty string, which       */
/* path.resolve turns into the working directory and sqlite cannot open.                   */
const dbPath = path.resolve(process.env.DB_PATH || './db/tokens.sqlite3');
const dbTemplatePath = path.resolve(__dirname, 'tokens_template.sqlite3');

if (fs.existsSync(dbPath) && fs.statSync(dbPath).isDirectory()) {
    throw new Error(`[DB] DB_PATH points at a directory, not a database file: ${dbPath}`);
}

/* The directory has to be there already; creating it would turn a mistyped DB_PATH into a
   silently empty database somewhere unexpected. Checked separately so that the failure names
   the directory rather than arriving as an ENOENT from the template copy below.

   Capitalisation is worth a look when this fires. On Azure App Service /home is a mounted
   share that preserves case, and whether /home/Data and /home/data are the same directory
   depends on the mount rather than on anything here; the path is used exactly as given. */
const dbDirectory = path.dirname(dbPath);

if (!fs.existsSync(dbDirectory)) {
    throw new Error(`[DB] The directory for the database does not exist: ${dbDirectory} ` +
        `(from DB_PATH '${process.env.DB_PATH ?? './db/tokens.sqlite3'}'). Create it first, and check the ` +
        'spelling and the capitalisation.');
}

/* Magic for Azure; if there is no existing db file, copy one from the template that has  */
/* journal_mode=WAL set, to work around the cifs mount issue.                             */
/* https://stackoverflow.com/questions/53226642/sqlite3-database-is-locked-in-azure       */
/* The copies are synchronous on purpose: the database below is opened on the next line   */
/* and an asynchronous copy is not necessarily finished by then.                          */
if (!fs.existsSync(dbPath)) {
    for (const suffix of ['', '-shm', '-wal']) {
        fs.copyFileSync(dbTemplatePath + suffix, dbPath + suffix);
    }

    log.info('[DB] No database file, created one using template (to fix Azure cifs mount bug).');
}

const db = new sqlite3.Database(dbPath);

log.info('[DB] Database file opened: ' + dbPath);

/* sqlite3 has a callback API. These are the three shapes of query used here, as promises. */
/* Note the return on every error path; without it the callback carries on and resolves a   */
/* promise it has already rejected, which hides the error.                                  */

const run = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
        if (err) {
            return reject(err);
        }

        resolve({ changes: this.changes, lastID: this.lastID });
    });
});

const all = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
        if (err) {
            return reject(err);
        }

        resolve(rows);
    });
});

const get = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
        if (err) {
            return reject(err);
        }

        resolve(row);
    });
});

/**
 * Makes sure a unique constraint exists on the key columns of a table.
 *
 * Versions of this application before the db rewrite created 'tokens' without a primary
 * key, and CREATE TABLE IF NOT EXISTS never adds one to a table that already exists. A
 * database file that has been in place since then therefore has no unique constraint on
 * the key columns even though the DDL below asks for one. The upserts need that
 * constraint, and without it INSERT OR REPLACE could not replace anything either, so such
 * a database can also hold several rows for the same key.
 *
 * Duplicates are dropped, keeping the row that was written last, and the constraint is
 * created. Both steps do nothing at all on a database that already has its primary key,
 * which is every database created from the template.
 *
 * The identifiers are interpolated because sqlite cannot bind them; they are literals
 * from the two call sites below and never come from a request.
 */
const ensureUniqueKey = async (table, keyColumns) => {
    for (const index of await all(`PRAGMA index_list(${table})`)) {
        if (!index.unique) {
            continue;
        }

        const columns = (await all(`PRAGMA index_info(${index.name})`)).map((column) => column.name);

        if (columns.length === keyColumns.length && keyColumns.every((column) => columns.includes(column))) {
            return;
        }
    }

    const keys = keyColumns.join(', ');
    const { changes } = await run(`DELETE FROM ${table} WHERE rowid NOT IN (SELECT max(rowid) FROM ${table} GROUP BY ${keys})`);

    if (changes) {
        log.info(`[DB] Dropped ${changes} duplicate row(s) from '${table}', left there by a version without a primary key.`);
    }

    await run(`CREATE UNIQUE INDEX IF NOT EXISTS ${table}_unique_key ON ${table} (${keys})`);

    log.info(`[DB] Added the missing unique key on '${table}' (${keys}).`);
};

/**
 * Creates the tables if they are not there. Every exported function awaits this, so a
 * request that arrives before the tables exist waits for them instead of failing.
 */
const ready = (async () => {
    /* WAL is what makes sqlite workable on the Azure network share; without it concurrent
       requests produce "database is locked". It used to be inherited from the template, but
       that only covers a database this application created itself. DB_PATH can point at a
       file from anywhere, and in particular VACUUM INTO writes its output in the default
       rollback mode, so the snapshot taken to move a database to /home/Data arrives as
       journal_mode=delete and silently loses the workaround.

       Setting it here does not depend on where the file came from. It is persistent in the
       file header, so this is a no-op on every startup after the first. */
    try {
        const current = await get('PRAGMA journal_mode');

        if (current?.journal_mode === 'wal') {
            log.info('[DB] Journal mode is WAL.');
        }
        else {
            /* Only ever attempted when it is actually needed. Setting the mode is a write to
               the file header and the switch is reported not to take on a cifs mount, which is
               why the template carries it pre-set; there is nothing to gain from trying it
               against a database that is already right. */
            log.info(`[DB] Journal mode is '${current?.journal_mode}', trying to switch to WAL.`);

            const changed = await get('PRAGMA journal_mode=WAL');

            if (changed?.journal_mode === 'wal') {
                log.info('[DB] Journal mode is now WAL.');
            }
            else {
                log.error(`[DB] Could not switch to WAL, still '${changed?.journal_mode}'. On the Azure network ` +
                    'share that turns into "database is locked" once two requests write at once. Set the mode on ' +
                    'a copy of the file somewhere local, where the switch does work, and put that copy in place.');
            }
        }
    }
    catch (error) {
        log.error('[DB] Could not read or set the journal mode: ' + error);
    }

    await run('CREATE TABLE IF NOT EXISTS tokens (user_id TEXT NOT NULL, user_env TEXT NOT NULL, api_token TEXT NOT NULL, refresh_token TEXT NOT NULL, expires_at_utc DATETIME NOT NULL, updated_at DATETIME NOT NULL DEFAULT current_timestamp, PRIMARY KEY (user_id, user_env))');
    log.info("[DB] Database main table 'tokens' ready.");

    await run('CREATE TABLE IF NOT EXISTS self_signup_config (canvas_course_id INTEGER NOT NULL, group_category_id INTEGER NOT NULL, assignment_id INTEGER NOT NULL, description TEXT, min_points INTEGER NOT NULL, created_at DATETIME NOT NULL DEFAULT current_timestamp, PRIMARY KEY (canvas_course_id, group_category_id))');
    log.info("[DB] Database table 'self_signup_config' ready.");

    /* For database files that predate the primary keys in the two statements above. */
    await ensureUniqueKey('tokens', ['user_id', 'user_env']);
    await ensureUniqueKey('self_signup_config', ['canvas_course_id', 'group_category_id']);

    await run('CREATE TABLE IF NOT EXISTS sessions (sid TEXT NOT NULL PRIMARY KEY, expires_at_utc TEXT NOT NULL, data TEXT NOT NULL)');
    await run('CREATE INDEX IF NOT EXISTS sessions_expires_at_utc ON sessions (expires_at_utc)');
    log.info("[DB] Database table 'sessions' ready.");
})();

ready.catch((error) => {
    log.error('[DB] The database could not be prepared: ' + error);
});

async function getAllClientsData() {
    await ready;

    const rows = await all('SELECT DISTINCT user_id, user_env, api_token, refresh_token, expires_at_utc, updated_at FROM tokens ORDER BY updated_at DESC');

    /* Fingerprints, not values: this feeds the administration pages. The names say so, so */
    /* that nobody reads the page and takes them for the tokens themselves.                */
    return rows.map((row) => ({
        user_id: row.user_id,
        user_env: row.user_env,
        api_token_fingerprint: tokenFingerprint(row.api_token),
        refresh_token_fingerprint: tokenFingerprint(row.refresh_token),
        expires_at: new Date(row.expires_at_utc).toISOString(),
        updated_at: new Date(row.updated_at).toISOString()
    }));
}

async function getAllSelfSignupConfigData() {
    await ready;

    const rows = await all('SELECT DISTINCT canvas_course_id, group_category_id, assignment_id, created_at FROM self_signup_config ORDER BY created_at DESC');

    return rows.map((row) => ({
        canvas_course_id: row.canvas_course_id,
        group_category_id: row.group_category_id,
        assignment_id: row.assignment_id,
        created_at: new Date(row.created_at).toISOString()
    }));
}

/* Test data for /test/sqlite3. Building it involves nothing asynchronous. */
function getAllClientsDataMocked() {
    log.info('[DB] Mocking up data for all clients.');

    return [
        { user_id: "abcdef_123456", user_env: "test", api_token: "api_token_1", refresh_token: "refresh_token_1",
          expires_at: new Date("2020-02-03T01:30:00Z").toISOString(), updated_at: new Date("2020-02-03T00:30:00Z").toISOString() },
        { user_id: "abcdef_746343", user_env: "test", api_token: "api_token_2", refresh_token: "refresh_token_2",
          expires_at: new Date("2020-02-03T03:30:00Z").toISOString(), updated_at: new Date("2020-02-03T02:30:00Z").toISOString() },
        { user_id: "bavads_746343", user_env: "test", api_token: "api_token_3", refresh_token: "refresh_token_3",
          expires_at: new Date("2020-02-02T21:30:00Z").toISOString(), updated_at: new Date("2020-02-02T20:30:00Z").toISOString() }
    ];
}

async function setClientData(userId, env, token, refresh, expires) {
    await ready;

    await run(
        'INSERT INTO tokens (user_id, user_env, api_token, refresh_token, expires_at_utc, updated_at) VALUES (?, ?, ?, ?, ?, current_timestamp) ' +
        'ON CONFLICT (user_id, user_env) DO UPDATE SET api_token = excluded.api_token, refresh_token = excluded.refresh_token, expires_at_utc = excluded.expires_at_utc, updated_at = current_timestamp',
        [userId, env, token, refresh, expires instanceof Date ? expires.toISOString() : expires]
    );

    log.info("[DB] Created/replaced token data for user_id '" + userId + "'");
}

/**
 * The token data for a user, or null when there is none. A missing token is a normal
 * state that the caller decides what to do about, so it is not an error here.
 */
async function getClientData(userId, env) {
    await ready;

    const row = await get('SELECT user_id, user_env, api_token, refresh_token, expires_at_utc FROM tokens WHERE user_id = ? AND user_env = ?', [userId, env]);

    if (!row) {
        log.info("[DB] No data in db for userId '" + userId + "'.");

        return null;
    }

    return {
        access_token: row.api_token,
        token_type: "Bearer",
        refresh_token: row.refresh_token,
        expires_in: 3600,
        expires_at_utc: new Date(row.expires_at_utc)
    };
}

async function setSelfSignupConfig(courseId, groupCategoryId, assignmentId, comment, minPoints) {
    await ready;

    await run(
        'INSERT INTO self_signup_config (canvas_course_id, group_category_id, assignment_id, description, min_points) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT (canvas_course_id, group_category_id) DO UPDATE SET assignment_id = excluded.assignment_id, description = excluded.description, min_points = excluded.min_points',
        [courseId, groupCategoryId, assignmentId, comment, minPoints]
    );

    log.info("[DB] Created/replaced self_signup_config data for course_id '" + courseId + "', assignment_id '" + assignmentId + "'");
}

/**
 * The rule for one group category, or null when the category has none.
 */
async function getSelfSignupConfig(courseId, groupCategoryId) {
    await ready;

    const row = await get('SELECT canvas_course_id, group_category_id, assignment_id, description, min_points, created_at FROM self_signup_config WHERE canvas_course_id = ? AND group_category_id = ?', [courseId, groupCategoryId]);

    return row ?? null;
}

async function getSelfSignupConnectedAssignments(courseId) {
    await ready;

    return all('SELECT DISTINCT canvas_course_id, group_category_id, assignment_id, min_points, description FROM self_signup_config WHERE canvas_course_id = ?', [courseId]);
}

async function clearSelfSignupConfig(courseId, groupCategoryId) {
    await ready;

    const { changes } = await run('DELETE FROM self_signup_config WHERE canvas_course_id = ? AND group_category_id = ?', [courseId, groupCategoryId]);

    return changes;
}

/**
 * Closes the connection. Only needed so that a test can let the process end.
 */
const close = () => new Promise((resolve, reject) => {
    db.close((err) => err ? reject(err) : resolve());
});

module.exports = {
    ready,
    close,
    tokenFingerprint,
    /* Where the database actually is, for the backup rotation to put its copies beside it. */
    databasePath: dbPath,
    /* The session store builds its own queries against the same connection. */
    sql: { run, all, get },
    getAllClientsDataMocked,
    getAllClientsData,
    getAllSelfSignupConfigData,
    setClientData,
    getClientData,
    setSelfSignupConfig,
    getSelfSignupConfig,
    getSelfSignupConnectedAssignments,
    clearSelfSignupConfig
};
