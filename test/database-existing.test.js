/* A database created and filled by the previous version of the code must keep working. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const ROOT = path.join(__dirname, '..');
const DB = path.join(__dirname, 'existing-db.sqlite3');

const run = (db, sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (db, sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, r) => e ? rej(e) : res(r)));

test('a database from the previous version still works', async (t) => {
    /* Build it the way the old code left it: copied from the template, then the old DDL
       and the old INSERT OR REPLACE statements. */
    for (const suffix of ['', '-shm', '-wal']) {
        try { fs.unlinkSync(DB + suffix); } catch { /* not there */ }
        fs.copyFileSync(path.join(ROOT, 'db', 'tokens_template.sqlite3') + suffix, DB + suffix);
    }

    const old = new sqlite3.Database(DB);

    await run(old, 'CREATE TABLE IF NOT EXISTS tokens (user_id TEXT NOT NULL, user_env TEXT NOT NULL, api_token TEXT NOT NULL, refresh_token TEXT NOT NULL, expires_at_utc DATETIME NOT NULL, updated_at DATETIME NOT NULL DEFAULT current_timestamp, PRIMARY KEY (user_id, user_env))');
    await run(old, 'CREATE TABLE IF NOT EXISTS self_signup_config (canvas_course_id INTEGER NOT NULL, group_category_id INTEGER NOT NULL, assignment_id INTEGER NOT NULL, description TEXT, min_points INTEGER NOT NULL, created_at DATETIME NOT NULL DEFAULT current_timestamp, PRIMARY KEY (canvas_course_id, group_category_id))');
    await run(old, 'INSERT OR REPLACE INTO tokens (user_id, user_env, api_token, refresh_token, expires_at_utc) VALUES (?, ?, ?, ?, ?)',
        ['prod_user_aaa', 'production', 'old-access-token', 'old-refresh-token', new Date('2030-01-01T00:00:00Z').toISOString()]);
    await run(old, 'INSERT OR REPLACE INTO tokens (user_id, user_env, api_token, refresh_token, expires_at_utc) VALUES (?, ?, ?, ?, ?)',
        ['prod_user_bbb', 'test', 'other-token', 'other-refresh', new Date('2030-01-01T00:00:00Z').toISOString()]);
    await run(old, 'INSERT OR REPLACE INTO self_signup_config (canvas_course_id, group_category_id, assignment_id, description, min_points) VALUES (?, ?, ?, ?, ?)',
        [4711, 8001, 500, 'Old rule', 3]);

    const oldTables = (await all(old, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")).map((r) => r.name);
    await new Promise((r) => old.close(r));

    /* Now open it with the current code. */
    process.env.DB_PATH = DB;
    const db = require(path.join(ROOT, 'db'));
    await db.ready;

    t.after(() => db.close());

    await t.test('the sessions table is added to the existing file', async () => {
        const tables = (await db.sql.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")).map((r) => r.name);

        assert.ok(!oldTables.includes('sessions'), 'the old db should not have had it');
        assert.ok(tables.includes('sessions'), tables.join(', '));
        assert.ok(tables.includes('tokens') && tables.includes('self_signup_config'), tables.join(', '));
    });

    await t.test('journal_mode is still WAL, which Azure needs', async () => {
        const { journal_mode } = await db.sql.get('PRAGMA journal_mode');

        assert.equal(journal_mode, 'wal');
    });

    await t.test('existing token rows read back', async () => {
        const token = await db.getClientData('prod_user_aaa', 'production');

        assert.equal(token.access_token, 'old-access-token');
        assert.equal(token.refresh_token, 'old-refresh-token');
        assert.ok(token.expires_at_utc instanceof Date && !isNaN(token.expires_at_utc));
    });

    await t.test('the statistics query copes with the old timestamps', async () => {
        const clients = await db.getAllClientsData();

        assert.equal(clients.length, 2);
        assert.ok(clients.every((c) => /^\d{4}-\d{2}-\d{2}T/.test(c.updated_at)), JSON.stringify(clients.map((c) => c.updated_at)));
    });

    await t.test('existing self signup rules read back', async () => {
        assert.equal((await db.getSelfSignupConfig(4711, 8001)).description, 'Old rule');
    });

    await t.test('the upsert updates a row the old code inserted', async () => {
        await db.setClientData('prod_user_aaa', 'production', 'refreshed-token', 'old-refresh-token', new Date('2031-01-01T00:00:00Z'));

        assert.equal((await db.getClientData('prod_user_aaa', 'production')).access_token, 'refreshed-token');
        assert.equal((await db.sql.get('SELECT count(*) c FROM tokens')).c, 2, 'must not have duplicated the row');
    });

    await t.test('the self signup upsert updates in place', async () => {
        await db.setSelfSignupConfig(4711, 8001, 501, 'New rule', 7);
        const rule = await db.getSelfSignupConfig(4711, 8001);

        assert.equal(rule.assignment_id, 501);
        assert.equal(rule.min_points, 7);
        assert.equal((await db.sql.get('SELECT count(*) c FROM self_signup_config')).c, 1);
    });

    await t.test('a session round trip works on the migrated file', async () => {
        const SqliteSessionStore = require(path.join(ROOT, 'session-store'));
        const store = new SqliteSessionStore({ ttlSeconds: 60 });
        const session = { cookie: { expires: new Date(Date.now() + 60000) }, userId: 'prod_user_aaa' };

        await new Promise((res, rej) => store.set('sid-1', session, (e) => e ? rej(e) : res()));
        const loaded = await new Promise((res, rej) => store.get('sid-1', (e, v) => e ? rej(e) : res(v)));

        assert.equal(loaded.userId, 'prod_user_aaa');
    });
});
