/*
 * The tokens table was created without a primary key before commit ceb146d, and
 * CREATE TABLE IF NOT EXISTS never adds one to a table that already exists. A database
 * file that has been in place since then has no unique constraint on the key columns,
 * which the upserts need, and can hold several rows for the same key because the old
 * INSERT OR REPLACE had nothing to replace on.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const sqlite3 = require('sqlite3');

const ROOT = path.join(__dirname, '..');
const DB = path.join(__dirname, 'pre-primary-key-db.sqlite3');

const run = (db, sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (db, sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, r) => e ? rej(e) : res(r)));

test('a database from before the primary keys migrates cleanly', async (t) => {
    for (const suffix of ['', '-shm', '-wal']) {
        try { fs.unlinkSync(DB + suffix); } catch { /* not there */ }
    }

    const old = new sqlite3.Database(DB);
    await run(old, 'PRAGMA journal_mode=WAL');

    /* The DDL as it was in 2bbe15c: no PRIMARY KEY. */
    await run(old, 'CREATE TABLE IF NOT EXISTS tokens (user_id TEXT NOT NULL, user_env TEXT NOT NULL, api_token TEXT NOT NULL, refresh_token TEXT NOT NULL, expires_at_utc DATETIME NOT NULL, updated_at DATETIME NOT NULL DEFAULT current_timestamp)');
    await run(old, 'CREATE TABLE IF NOT EXISTS self_signup_config (canvas_course_id INTEGER NOT NULL, group_category_id INTEGER NOT NULL, assignment_id INTEGER NOT NULL, description TEXT, min_points INTEGER NOT NULL, created_at DATETIME NOT NULL DEFAULT current_timestamp)');

    /* Every refresh appended a row instead of replacing one. */
    for (const token of ['token-v1', 'token-v2', 'token-v3-newest']) {
        await run(old, 'INSERT OR REPLACE INTO tokens (user_id, user_env, api_token, refresh_token, expires_at_utc) VALUES (?, ?, ?, ?, ?)',
            ['dup_user', 'production', token, 'refresh-' + token, new Date('2030-01-01T00:00:00Z').toISOString()]);
    }
    await run(old, 'INSERT OR REPLACE INTO tokens (user_id, user_env, api_token, refresh_token, expires_at_utc) VALUES (?, ?, ?, ?, ?)',
        ['single_user', 'production', 'only-token', 'only-refresh', new Date('2030-01-01T00:00:00Z').toISOString()]);
    for (const points of [1, 5]) {
        await run(old, 'INSERT OR REPLACE INTO self_signup_config (canvas_course_id, group_category_id, assignment_id, description, min_points) VALUES (?, ?, ?, ?, ?)',
            [4711, 8001, 500, 'rule with ' + points, points]);
    }

    const uniqueBefore = (await all(old, 'PRAGMA index_list(tokens)')).filter((i) => i.unique);
    const rowsBefore = (await all(old, 'SELECT count(*) c FROM tokens'))[0].c;
    await new Promise((r) => old.close(r));

    assert.equal(uniqueBefore.length, 0, 'the fixture must really lack a unique index');
    assert.equal(rowsBefore, 4, 'the fixture must really hold duplicates');

    process.env.DB_PATH = DB;
    const db = require(path.join(ROOT, 'db'));
    await db.ready;

    t.after(() => db.close());

    await t.test('the missing unique key is created', async () => {
        const unique = (await db.sql.all('PRAGMA index_list(tokens)')).filter((i) => i.unique);

        assert.equal(unique.length, 1, JSON.stringify(unique.map((i) => i.name)));
    });

    await t.test('duplicate rows collapse to the one written last', async () => {
        const rows = await db.sql.all('SELECT user_id, api_token FROM tokens ORDER BY user_id');

        assert.equal(rows.length, 2, JSON.stringify(rows));
        assert.equal(rows.find((r) => r.user_id === 'dup_user').api_token, 'token-v3-newest');
        assert.equal(rows.find((r) => r.user_id === 'single_user').api_token, 'only-token');
    });

    await t.test('self_signup_config is deduplicated the same way', async () => {
        const rules = await db.sql.all('SELECT min_points FROM self_signup_config');

        assert.equal(rules.length, 1);
        assert.equal(rules[0].min_points, 5);
    });

    await t.test('the upsert works once the constraint is there', async () => {
        await db.setClientData('dup_user', 'production', 'token-v4', 'refresh-v4', new Date('2031-01-01T00:00:00Z'));

        assert.equal((await db.getClientData('dup_user', 'production')).access_token, 'token-v4');
        assert.equal((await db.sql.get('SELECT count(*) c FROM tokens')).c, 2);
    });

    await t.test('journal_mode is left as WAL', async () => {
        assert.equal((await db.sql.get('PRAGMA journal_mode')).journal_mode, 'wal');
    });

    await t.test('a second startup changes nothing', () => {
        /* A fresh process, because the db module is a singleton in this one. */
        const script = `
            process.env.DB_PATH = ${JSON.stringify(DB)};
            const db = require(${JSON.stringify(path.join(ROOT, 'db'))});
            db.ready.then(async () => {
                const unique = (await db.sql.all('PRAGMA index_list(tokens)')).filter((i) => i.unique);
                const rows = await db.sql.get('SELECT count(*) c FROM tokens');
                await db.close();
                process.stdout.write(JSON.stringify({ unique: unique.length, rows: rows.c }));
            }).catch((e) => { console.error(e); process.exit(1); });
        `;
        const out = execFileSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const result = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));

        assert.deepEqual(result, { unique: 1, rows: 2 }, out);
    });
});
