'use strict';

const sqlite3 = require('sqlite3').verbose();
const log = require('../log');
const path = require('path');
const dbPath = path.resolve('./db/tokens.sqlite3');
const dbTemplatePath = path.resolve('./db/tokens_template.sqlite3');
const fs = require('fs');

// magic for azure; if no existing db file, copy from template with journal_mode=WAL to fix cifs mount issue
// https://stackoverflow.com/questions/53226642/sqlite3-database-is-locked-in-azure/66567897
if (!fs.existsSync(dbPath)) {
    fs.copyFile(dbTemplatePath, dbPath, (err) => {
        if (err) throw err;
        log.info('[DB] No database file, created one using template (to fix Azure cifs mount bug).');
    });
    fs.copyFile(dbTemplatePath + '-shm', dbPath + '-shm', (err) => {
        if (err) throw err;
    });
    fs.copyFile(dbTemplatePath + '-wal', dbPath + '-wal', (err) => {
        if (err) throw err;
    });
}

// open database file
const db = new sqlite3.Database(dbPath);
// db.run('PRAGMA journal_mode=wal;');
log.info("[DB] Database file opened: " + dbPath);

// call the setup function to create the table if it doesn't exist
setupDatabase();

// function to set up the database
async function setupDatabase() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
        db.run('CREATE TABLE IF NOT EXISTS tokens (user_id TEXT NOT NULL, user_env TEXT NOT NULL, api_token TEXT NOT NULL, refresh_token TEXT NOT NULL, expires_at_utc DATETIME NOT NULL, updated_at DATETIME NOT NULL DEFAULT current_timestamp, PRIMARY KEY (user_id, user_env))', (err) => {
            if (err) reject(err);
            
        log.info("[DB] Database main table 'tokens' ready.");
        resolve();
      });
    });
    db.serialize(() => {
        db.run('CREATE TABLE IF NOT EXISTS self_signup_config (canvas_course_id INTEGER NOT NULL, group_category_id INTEGER NOT NULL, assignment_id INTEGER NOT NULL, description TEXT, min_points INTEGER NOT NULL, created_at DATETIME NOT NULL DEFAULT current_timestamp, PRIMARY KEY (canvas_course_id, group_category_id))', (err) => {
            if (err) reject(err);
            
        log.info("[DB] Database table 'self_signup_config' ready.");
        resolve();
      });
    });
  });
}

async function getAllClientsData() {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.all('SELECT DISTINCT user_id, user_env, api_token, refresh_token, expires_at_utc, updated_at FROM tokens ORDER BY updated_at DESC', (err, rows) => {
                if (err) reject(err);

                const clientData = [];

                rows.forEach((row) => {
                    clientData.push({
                        user_id: row.user_id,
                        user_env: row.user_env,
                        api_token: row.api_token,
                        refresh_token: row.refresh_token,
                        expires_at: new Date(row.expires_at_utc).toISOString(),
                        updated_at: new Date(row.updated_at).toISOString()
                    });
                });

                resolve(clientData);
            });
        });
    });
}


async function getAllClientsDataMocked() {
    return new Promise((resolve, reject) => {
        log.info("[DB] Mocking up data for all clients.");

        var clientData = [];

        var thisData1 = { user_id: "abcdef_123456", user_env: "test", api_token: "api_token_1", refresh_token: "refresh_token_1",
        expires_at: new Date("2020-02-03T01:30:00Z").toISOString(), updated_at: new Date("2020-02-03T00:30:00Z").toISOString()};
        var thisData2 = { user_id: "abcdef_746343", user_env: "test", api_token: "api_token_2", refresh_token: "refresh_token_2",
        expires_at: new Date("2020-02-03T03:30:00Z").toISOString(), updated_at: new Date("2020-02-03T02:30:00Z").toISOString()};
        var thisData3 = { user_id: "bavads_746343", user_env: "test", api_token: "api_token_3", refresh_token: "refresh_token_3",
        expires_at: new Date("2020-02-02T21:30:00Z").toISOString(), updated_at: new Date("2020-02-02T20:30:00Z").toISOString()};

        clientData.push(thisData1);    
        clientData.push(thisData2);
        clientData.push(thisData3);

        resolve(clientData);
    });
}

async function setClientData(userId, env, token, refresh, expires) {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
          const stmt = db.prepare('INSERT OR REPLACE INTO tokens (user_id, user_env, api_token, refresh_token, expires_at_utc) VALUES (?, ?, ?, ?, ?)');
          stmt.run(userId, env, token, refresh, expires, (err) => {
            if (err) reject(err);
            
            log.info("[DB] Created/replaced token data for user_id '" + userId + "'");
            resolve();
          });
          stmt.finalize();
        });
    });
}


async function getClientData(userId, env) {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.all('SELECT DISTINCT user_id, user_env, api_token, refresh_token, expires_at_utc FROM tokens WHERE user_id = ? AND user_env = ?', [userId, env], (err, rows) => {
                if (err) reject(err);
                
                let tokenData = {};
    
                if (rows.length) {
                    tokenData.access_token = rows[0].api_token;
                    tokenData.token_type = "Bearer";
                    tokenData.refresh_token = rows[0].refresh_token;
                    tokenData.expires_in = 3600;
                    tokenData.expires_at_utc = new Date(rows[0].expires_at_utc);
    
                    resolve(tokenData);
                }
                else {
                    log.info("[DB] No data in db for userId '" + userId + "'.");
    
                    reject('No data');
                }
            });
        });
    });
}

async function setSelfSignupConfig(courseId, groupCategoryId, assignmentId, comment, minPoints, env) {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
          const stmt = db.prepare('INSERT OR REPLACE INTO self_signup_config (canvas_course_id, group_category_id, assignment_id, description, min_points) VALUES (?, ?, ?, ?, ?)');
          stmt.run(courseId, groupCategoryId, assignmentId, comment, minPoints, (err) => {
            if (err) reject(err);
            
            log.info("[DB] Created/replaced self_signup_config data for course_id '" + courseId + "', assignment_id '" + assignmentId + "'");
            resolve();
          });
          stmt.finalize();
        });
    });
}

async function getSelfSignupConfig(courseId, groupCategoryId) {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.all('SELECT DISTINCT canvas_course_id, group_category_id, assignment_id, description, min_points, created_at FROM self_signup_config WHERE canvas_course_id = ? AND group_category_id = ?', [courseId, groupCategoryId], (err, rows) => {
                if (err) reject(err);
                
                let configData = {};

                if (rows) {
                    resolve(rows[0]);
                }
                else {
                    log.info("[DB] No data in db for courseId '" + courseId + "', groupCategoryId '" + groupCategoryId + "'");

                    reject('No data');
                }
            });
        });
    });
}

async function getSelfSignupConnectedAssignments(courseId) {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.all('SELECT DISTINCT canvas_course_id, group_category_id, assignment_id, min_points, description FROM self_signup_config WHERE canvas_course_id = ?', [courseId], (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
        });
    });
}

async function clearSelfSignupConfig(courseId, groupCategoryId) {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.all('DELETE FROM self_signup_config WHERE canvas_course_id = ? AND group_category_id = ?', [courseId, groupCategoryId], (err, rows) => {
                if (err) reject(err);
                resolve();
            });
        });
    });
}

module.exports = {
    getAllClientsDataMocked,
    getAllClientsData,
    setClientData,
    getClientData,
    setSelfSignupConfig,
    getSelfSignupConfig,
    getSelfSignupConnectedAssignments,
    clearSelfSignupConfig
}
