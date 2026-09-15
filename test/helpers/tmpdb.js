/* A database path for a test, in a directory of its own outside the working copy. */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * A test must not write into the working copy. `DB_PATH` inside the repository leaves the
 * database and, since the rotating copies are written beside it, a `backups` directory as
 * well, so a run leaves untracked files behind. An ignore rule would hide those writes rather
 * than stop them, and an interrupted run would still make them.
 *
 * A directory per call, so tests that run in the same process cannot reach each other's files.
 */
module.exports = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lti-test-')), name);
