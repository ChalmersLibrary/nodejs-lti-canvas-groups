/*
 * WAL is the workaround for running sqlite on the Azure network share, and it used to be
 * inherited from db/tokens_template.sqlite3. That only covers a database this application
 * created. VACUUM INTO writes its output in the default rollback journal mode, so the
 * snapshot taken to move a database somewhere else arrives as journal_mode=delete, which
 * would drop the workaround without anything saying so.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const sqlite3 = require('sqlite3');

const ROOT = path.join(__dirname, '..');

const run = (db, sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const get = (db, sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, r) => e ? rej(e) : res(r)));

/* Opens the path with the application's db module in a fresh process, since the module
   resolves and opens once when it is first required. */
const openWithApp = (dbPath) => {
    const script = `
        process.env.DB_PATH = ${JSON.stringify(dbPath)};
        const db = require(${JSON.stringify(path.join(ROOT, 'db'))});
        db.ready
            .then(async () => {
                const journal = await db.sql.get('PRAGMA journal_mode');
                await db.close();
                process.stdout.write('JOURNAL:' + journal.journal_mode);
            })
            .catch((e) => { process.stderr.write(String(e)); process.exit(1); });
    `;
    const out = execFileSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

    return out.slice(out.indexOf('JOURNAL:') + 'JOURNAL:'.length).trim();
};

test('a database snapshotted with VACUUM INTO is put back into WAL', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lti-journal-'));
    const source = path.join(dir, 'source.sqlite');
    const snapshot = path.join(dir, 'moved.sqlite');

    /* Build a WAL database with something in it, the way a live one looks. */
    const db = new sqlite3.Database(source);
    await run(db, 'PRAGMA journal_mode=WAL');
    await run(db, 'CREATE TABLE tokens (user_id TEXT NOT NULL, user_env TEXT NOT NULL, api_token TEXT NOT NULL, refresh_token TEXT NOT NULL, expires_at_utc DATETIME NOT NULL, updated_at DATETIME NOT NULL DEFAULT current_timestamp, PRIMARY KEY (user_id, user_env))');
    await run(db, 'INSERT INTO tokens VALUES (?,?,?,?,?,current_timestamp)', ['u1', 'production', 'tok', 'ref', '2030-01-01']);

    assert.equal((await get(db, 'PRAGMA journal_mode')).journal_mode, 'wal', 'the fixture should be WAL');

    /* The move procedure from the README. */
    await run(db, `VACUUM INTO '${snapshot.replace(/\\/g, '/')}'`);
    await new Promise((r) => db.close(r));

    const asSnapshotted = new sqlite3.Database(snapshot);
    const modeBefore = (await get(asSnapshotted, 'PRAGMA journal_mode')).journal_mode;
    await new Promise((r) => asSnapshotted.close(r));

    assert.equal(modeBefore, 'delete', 'VACUUM INTO is expected to write the default journal mode');

    /* Which is exactly what the application has to correct. */
    assert.equal(openWithApp(snapshot), 'wal', 'the application should have put it into WAL');

    /* And it is persistent, so a second start finds it already set. */
    assert.equal(openWithApp(snapshot), 'wal');

    const rows = await new Promise((res, rej) => {
        const check = new sqlite3.Database(snapshot);
        check.get('SELECT count(*) AS c FROM tokens', (e, r) => e ? rej(e) : check.close(() => res(r.c)));
    });

    assert.equal(rows, 1, 'and the data survived all of it');
});

test('a database that is already WAL is left alone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lti-journal-wal-'));

    /* Nothing there, so the application creates it from the template, which is WAL. */
    assert.equal(openWithApp(path.join(dir, 'fresh.sqlite')), 'wal');
});
