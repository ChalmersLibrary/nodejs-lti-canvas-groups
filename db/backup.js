'use strict';

const fs = require('node:fs');
const path = require('node:path');
const db = require('./index');
const log = require('../log');

/**
 * Rotating copies of the database, next to the database itself.
 *
 * The file lives on persistent storage that survives restarts, scaling and Azure moving the
 * app to other hardware, so this is not about the machine going away. It is about the file
 * being deleted, overwritten or corrupted, which has happened once: the database was moved
 * aside during debugging, the application created an empty one from the template, and 68 self
 * signup rules had to be merged back out of the old copy afterwards.
 *
 * Tokens are not what this protects. Losing one costs the user a silent reauthorization, since
 * the approval itself lives in Canvas. The self signup rules are the part nothing else holds a
 * copy of.
 *
 * VACUUM INTO rather than copying the file: it writes one consistent file with everything that
 * is still in the write-ahead log, it can run while the application is serving requests, and it
 * refuses to overwrite an existing output, so it can never damage a good copy.
 */

const DEFAULT_KEEP = 7;
const DEFAULT_INTERVAL_HOURS = 24;

const backupDirectory = () => path.join(path.dirname(db.databasePath), 'backups');

/* grouptool.sqlite -> grouptool-2026-08-22.sqlite. One per day: a restart loop cannot fill the
   disk, and the name says what it is without opening it. */
const backupName = (date) => {
    const extension = path.extname(db.databasePath) || '.sqlite';
    const base = path.basename(db.databasePath, extension);

    return `${base}-${date.toISOString().slice(0, 10)}${extension}`;
};

const isBackupName = (name) => {
    const extension = path.extname(db.databasePath) || '.sqlite';
    const base = path.basename(db.databasePath, extension);

    return new RegExp(`^${base}-\\d{4}-\\d{2}-\\d{2}${extension.replace('.', '\\.')}$`).test(name);
};

/**
 * Writes today's copy, or does nothing when it is already there. Returns the path written, or
 * null when there was nothing to do.
 */
const take = async (now = new Date()) => {
    const directory = backupDirectory();
    const target = path.join(directory, backupName(now));

    fs.mkdirSync(directory, { recursive: true });

    if (fs.existsSync(target)) {
        log.debug(`[Backup] Today's copy is already there: ${target}`);

        return null;
    }

    /* The filename cannot be a bound parameter in VACUUM INTO. It is built from the configured
       database path and a date, never from a request, and a quote in it is doubled anyway. */
    await db.sql.run(`VACUUM INTO '${target.replace(/'/g, "''")}'`);

    log.info(`[Backup] Wrote ${target} (${fs.statSync(target).size} bytes).`);

    return target;
};

/**
 * Deletes all but the newest `keep` copies. Sorting by name is sorting by date, since the name
 * ends in an ISO date.
 */
const prune = (keep) => {
    const directory = backupDirectory();

    if (!fs.existsSync(directory)) {
        return [];
    }

    const backups = fs.readdirSync(directory).filter(isBackupName).sort();
    const removed = [];

    for (const name of backups.slice(0, Math.max(0, backups.length - keep))) {
        try {
            fs.unlinkSync(path.join(directory, name));
            removed.push(name);
        }
        catch (error) {
            log.error(`[Backup] Could not remove ${name}: ${error}`);
        }
    }

    if (removed.length) {
        log.info(`[Backup] Removed ${removed.length} copy(ies) older than the last ${keep}: ${removed.join(', ')}`);
    }

    return removed;
};

/**
 * One round: a copy, then the rotation. Never throws; a backup that fails must not take the
 * application with it, and the log is what says so.
 */
const run = async (keep) => {
    try {
        await db.ready;
        await take();
        prune(keep);
    }
    catch (error) {
        log.error('[Backup] Could not write a copy of the database: ' + error);
    }
};

/**
 * Starts the rotation. One round now, so that a database that has never been copied is covered
 * before anything else happens to it, then one every intervalHours.
 */
exports.start = () => {
    const keep = process.env.dbBackupKeep === undefined ? DEFAULT_KEEP : parseInt(process.env.dbBackupKeep, 10);
    const intervalHours = parseFloat(process.env.dbBackupIntervalHours) > 0
        ? parseFloat(process.env.dbBackupIntervalHours)
        : DEFAULT_INTERVAL_HOURS;

    if (!(keep > 0)) {
        log.info('[Backup] Disabled, dbBackupKeep is ' + process.env.dbBackupKeep + '.');

        return null;
    }

    log.info(`[Backup] Keeping the last ${keep} daily copies in ${backupDirectory()}.`);

    run(keep);

    const timer = setInterval(() => run(keep), intervalHours * 3600 * 1000);

    /* Must not hold the process open on shutdown. */
    timer.unref();

    return timer;
};

/* Exported for the tests, which drive a round directly rather than waiting for a timer. */
exports.take = take;
exports.prune = prune;
exports.backupDirectory = backupDirectory;
exports.backupName = backupName;
