/*
 * Rotating copies of the database. The point of these is the self signup rules, which nothing
 * else holds a copy of, so a backup that is not readable afterwards is no backup at all.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const ROOT = path.join(__dirname, '..');

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lti-backup-'));
const DB = path.join(workDir, 'grouptool.sqlite');

process.env.DB_PATH = DB;

const db = require(path.join(ROOT, 'db'));
const backup = require(path.join(ROOT, 'db', 'backup'));

test.after(() => db.close());

test('a copy is written beside the database and is readable on its own', async () => {
    await db.ready;
    await db.setClientData('u1', 'production', 'tok', 'ref', new Date('2030-01-01T00:00:00Z'));
    await db.setSelfSignupConfig(4711, 8001, 500, 'Pass the quiz', 3);

    const written = await backup.take();

    assert.ok(written, 'a copy should have been written');
    assert.equal(path.dirname(written), path.join(workDir, 'backups'));
    assert.match(path.basename(written), /^grouptool-\d{4}-\d{2}-\d{2}\.sqlite$/);

    /* One self contained file: no -wal or -shm needed to read it. */
    assert.ok(!fs.existsSync(written + '-wal'));

    const rules = await new Promise((resolve, reject) => {
        const copy = new sqlite3.Database(written, sqlite3.OPEN_READONLY);
        copy.get('SELECT count(*) AS c, max(description) AS d FROM self_signup_config', (e, r) => {
            if (e) return reject(e);
            copy.close(() => resolve(r));
        });
    });

    assert.equal(rules.c, 1, 'the rule should be in the copy');
    assert.equal(rules.d, 'Pass the quiz');
});

test('a second round on the same day does not write again', async () => {
    const again = await backup.take();

    assert.equal(again, null, 'today is already covered');
    assert.equal(fs.readdirSync(path.join(workDir, 'backups')).length, 1);
});

test('the rotation keeps the newest and drops the rest', async () => {
    const directory = path.join(workDir, 'backups');

    /* Stand-ins for previous days. The name carries the date, so sorting by name is by date. */
    for (const day of ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04']) {
        fs.writeFileSync(path.join(directory, `grouptool-${day}.sqlite`), 'older');
    }

    /* Something that is not a backup, which must be left alone. */
    fs.writeFileSync(path.join(directory, 'notes.txt'), 'keep me');

    const before = fs.readdirSync(directory).filter((f) => f.endsWith('.sqlite')).sort();
    assert.equal(before.length, 5);

    const removed = backup.prune(2);

    const after = fs.readdirSync(directory).sort();

    assert.equal(removed.length, 3, `expected three removed, got ${removed.join(', ')}`);
    assert.deepEqual(
        after.filter((f) => f.endsWith('.sqlite')),
        [before[3], before[4]],
        'the two newest by date should remain'
    );
    assert.ok(after.includes('notes.txt'), 'an unrelated file must not be touched');
});

test('a failed round does not throw out of start', () => {
    /* Nothing may escape into the application: a missing backup is not worth a crash. */
    const original = process.env.dbBackupKeep;
    process.env.dbBackupKeep = '0';

    try {
        assert.equal(backup.start(), null, 'keep of zero disables the rotation');
    }
    finally {
        if (original === undefined) delete process.env.dbBackupKeep;
        else process.env.dbBackupKeep = original;
    }
});

test('the rotation schedules and the timer does not hold the process open', () => {
    const timer = backup.start();

    assert.ok(timer, 'a timer should have been returned');
    assert.equal(typeof timer.unref, 'function');
    clearInterval(timer);
});
