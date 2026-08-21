/*
 * DB_PATH resolution.
 *
 * Copying .env.example to .env leaves optional variables present but empty, so DB_PATH
 * arrives as "" rather than undefined. An empty path must fall back to the default: with ??
 * the empty string wins, path.resolve turns it into the working directory, and sqlite fails
 * to open it with SQLITE_CANTOPEN after the application has already said it is listening.
 *
 * Each case runs in its own process, because the db module resolves the path once when it
 * is first required.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

/* Runs the db module with the given DB_PATH, from a working directory of its own so that
   the default relative path cannot land on the real database. */
const openWith = (dbPathValue) => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lti-dbpath-'));
    fs.mkdirSync(path.join(workDir, 'db'));

    const script = `
        process.env.DB_PATH = ${JSON.stringify(dbPathValue)};
        const db = require(${JSON.stringify(path.join(ROOT, 'db'))});
        db.ready
            .then(async () => {
                await db.sql.get('SELECT count(*) AS c FROM tokens');
                await db.close();
                process.stdout.write('OPENED');
            })
            .catch((e) => { process.stderr.write('READY_FAILED: ' + e.message); process.exit(1); });
    `;

    try {
        const stdout = execFileSync(process.execPath, ['-e', script], {
            cwd: workDir,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe']
        });

        return { workDir, ok: stdout.includes('OPENED'), output: stdout };
    }
    catch (error) {
        return { workDir, ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
    }
};

test('an empty DB_PATH falls back to the default instead of failing to open', () => {
    const { workDir, ok, output } = openWith('');

    assert.ok(ok, `the database should have opened, got: ${output}`);
    assert.ok(
        fs.existsSync(path.join(workDir, 'db', 'tokens.sqlite3')),
        `expected the default path under the working directory, found: ${fs.readdirSync(path.join(workDir, 'db')).join(', ')}`
    );
});

test('a DB_PATH that is set is used', () => {
    const explicit = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lti-dbexplicit-')), 'chosen.sqlite3');
    const { ok, output } = openWith(explicit);

    assert.ok(ok, `the database should have opened, got: ${output}`);
    assert.ok(fs.existsSync(explicit), 'the file should be at the path that was asked for');
});

test('a DB_PATH whose directory is missing names the directory, not ENOENT', () => {
    /* The mistake this catches is a mistyped or miscapitalised path, which on Azure App
       Service is easy: /home is a case-preserving share, so /home/Data and /home/data may or
       may not be the same directory depending on the mount. */
    const missing = path.join(os.tmpdir(), 'lti-nope-' + process.pid, 'Data', 'tokens.sqlite3');
    const { ok, output } = openWith(missing);

    assert.ok(!ok, 'it must not start with nowhere to put the database');
    assert.match(output, /directory for the database does not exist/, output);
    assert.match(output, /capitalisation/, 'the message should point at the likely cause');
    assert.doesNotMatch(output, /ENOENT/, 'the raw copyfile error should not be what surfaces');
});

test('a DB_PATH pointing at a directory says so, rather than SQLITE_CANTOPEN', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lti-dbdir-'));
    const { ok, output } = openWith(directory);

    assert.ok(!ok, 'opening a directory must not succeed');
    assert.match(output, /points at a directory/, output);
    assert.doesNotMatch(output, /SQLITE_CANTOPEN/, 'the unhelpful error should not be what surfaces');
});
