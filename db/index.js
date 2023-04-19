'use strict';

const sqlite3 = require('sqlite3').verbose();
const log = require('../log');
const path = require('path');
const dbPath = path.resolve('./db/tokens.sqlite3');

// database file
const db = new sqlite3.Database(dbPath);
db.run('PRAGMA journal_mode=WAL;')

log.info("Database file opened: " + dbPath);
console.log(db);

// call the setup function to create the table
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
    
                if (rows) {
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

module.exports = {
    getAllClientsDataMocked,
    getAllClientsData,
    setClientData,
    getClientData,
}
