'use strict';

const { Store } = require('express-session');
const db = require('../db');
const log = require('../log');

const REAP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Session store backed by the application's own sqlite database.
 *
 * It replaces session-file-store, which kept one json file per session and rewrote the
 * whole file on every request. With a rolling cookie that includes the touch that every
 * request makes, and the assets on a page are requested in parallel with the page, so
 * those read-modify-writes overlapped. On Azure the files live on a network share, which
 * made lost updates likely enough that a session could come back without its token; the
 * token-from-database fallback in the canvas module exists because of it.
 *
 * Here a touch updates the expiry column alone and never rewrites the session data, so a
 * request that only touches the session can not roll back what another one just wrote,
 * and sqlite serialises the writes that do change data.
 */
class SqliteSessionStore extends Store {
    #reapTimer;

    constructor({ ttlSeconds = 3600 * 12, reapIntervalMs = REAP_INTERVAL_MS } = {}) {
        super();

        this.ttlSeconds = ttlSeconds;

        /* unref so that the timer does not hold the process open on shutdown. */
        this.#reapTimer = setInterval(() => {
            this.reap().catch((error) => log.error('[SessionStore] Reaping expired sessions: ' + error));
        }, reapIntervalMs);
        this.#reapTimer.unref();
    }

    /**
     * express-session has a callback API, and a store method that throws instead of
     * calling back leaves the request hanging. Everything below therefore runs through
     * this, which turns one promise into one callback exactly once.
     */
    static #settle(promise, callback) {
        promise.then(
            (value) => callback?.(null, value),
            (error) => callback?.(error)
        );
    }

    #expiresAt(session) {
        const cookieExpires = session?.cookie?.expires;

        if (cookieExpires) {
            return new Date(cookieExpires).toISOString();
        }

        return new Date(Date.now() + this.ttlSeconds * 1000).toISOString();
    }

    get(sid, callback) {
        SqliteSessionStore.#settle((async () => {
            const row = await db.sql.get(
                'SELECT data FROM sessions WHERE sid = ? AND expires_at_utc > ?',
                [sid, new Date().toISOString()]
            );

            /* express-session takes undefined as "no such session". */
            return row ? JSON.parse(row.data) : undefined;
        })(), callback);
    }

    set(sid, session, callback) {
        SqliteSessionStore.#settle(db.sql.run(
            'INSERT INTO sessions (sid, expires_at_utc, data) VALUES (?, ?, ?) ' +
            'ON CONFLICT (sid) DO UPDATE SET expires_at_utc = excluded.expires_at_utc, data = excluded.data',
            [sid, this.#expiresAt(session), JSON.stringify(session)]
        ), callback);
    }

    /**
     * Only the expiry is written here. This is the whole point of the store: the session
     * data of a request that did not change anything must never be written back.
     */
    touch(sid, session, callback) {
        SqliteSessionStore.#settle(db.sql.run(
            'UPDATE sessions SET expires_at_utc = ? WHERE sid = ?',
            [this.#expiresAt(session), sid]
        ), callback);
    }

    destroy(sid, callback) {
        SqliteSessionStore.#settle(db.sql.run('DELETE FROM sessions WHERE sid = ?', [sid]), callback);
    }

    clear(callback) {
        SqliteSessionStore.#settle(db.sql.run('DELETE FROM sessions'), callback);
    }

    length(callback) {
        SqliteSessionStore.#settle((async () => {
            const row = await db.sql.get('SELECT COUNT(*) AS count FROM sessions WHERE expires_at_utc > ?', [new Date().toISOString()]);

            return row.count;
        })(), callback);
    }

    all(callback) {
        SqliteSessionStore.#settle((async () => {
            const rows = await db.sql.all('SELECT sid, data FROM sessions WHERE expires_at_utc > ?', [new Date().toISOString()]);

            return Object.fromEntries(rows.map((row) => [row.sid, JSON.parse(row.data)]));
        })(), callback);
    }

    async reap() {
        const { changes } = await db.sql.run('DELETE FROM sessions WHERE expires_at_utc <= ?', [new Date().toISOString()]);

        if (changes) {
            log.info(`[SessionStore] Removed ${changes} expired session(s).`);
        }

        return changes;
    }
}

module.exports = SqliteSessionStore;
