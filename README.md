# Canvas Group Tool

LTI Application for working with Canvas groups, groupsets and users using Node.js.


## Overview

This project is forked from https://github.com/js-kyle/nodejs-lti-provider which is the template for a minimal LTI provider
application written in Node.js by Kyle Martin.


## Requirements

Node.js 24 or later (see `.nvmrc`). The version is enforced by `engines` in `package.json`.


## Installation

```
# Install dependencies using npm
$ npm install

# Run the app
$ npm start

# Run the app and restart on file changes
$ npm run dev

# Run the tests (signed LTI launch, OAuth and group views against a mocked Canvas API)
$ npm test

# Access from browser
http://localhost:3000
```

## Running in Azure App Service

Connect with Github or Bitbucket to your repository. When syncing, the build and install process should kick in and the app should be
available on the App Service URI shortly.


## Environment variables / Azure application settings

`canvasApiCacheSecondsTTL` number of seconds to cache responses from Canvas API. (Optional)

`canvasBaseUri` used as fallback if API Domain can not be read from LTI. Example: "https://school.instructure.com". (Optional)

`oauthClientId` the client id in Canvas Developer Keys, under Details. (Required)

`oauthClientSecret` the client key in Canvas Developer Keys. (Required)

`ltiConsumerKeys` consumer keys in format "key:secret[,key:secret]". Example: "canvas:abc123,protools:bnn625". Used in the app integration in Canvas. (Required)

`adminCanvasUserIds` comma-separated list of Canvas user ids that should have admin access. Long format id. (Optional)

`debugLogging` set to "true" for some more logging from LTI, etc. (Optional)

`canvasApiConcurrency` how many groups or categories are read from Canvas at the same time. Default 5. Set it to 1 to go back to reading them strictly one after the other, should Canvas start answering 403 because of its own rate limiting. (Optional)

`DB_PATH` path to the sqlite database file. Default `./db/tokens.sqlite3`. The tests point it somewhere else so that they do not write into the database being developed against. (Optional)

`systemApiToken` Canvas API token used for the anonymous public self signup endpoint. (Optional)

**Node version in Azure.** `WEBSITE_NODE_DEFAULT_VERSION` has to be set to a Node 24 runtime (`~24`). The old note here said 12.13.0 because of trouble building the sqlite3 native module; that is no longer an issue, sqlite3 6 ships prebuilt binaries. Check that the runtime is actually available on the App Service plan before deploying, since the Windows flavour of App Service lags behind on Node versions.



## Integrating in Canvas

You must first create a Developer Key for this application, then store the values in environment variables `oauthClientId` and `oauthClientSecret`. Then, add the application as a LTI Application to Canvas. Use the XML in [conf-lti-template.xml](https://github.com/ChalmersLibrary/nodejs-lti-canvas-groups/blob/27948de93c6bd83901985bd75d1da0ac45080c81/conf-lti-template.xml) and fill out the correct Consumer Key and Secret, which you store in environment variable `ltiConsumerKeys`. The main LTI Launch point is `/launch_lti`.


## Usage

`GET /` check the application availability and version, JSON data.

`POST /launch_lti` LTI launch URL. This receives a `application/x-www-form-urlencoded` POST request, with the parameters passed according to the LTI specification. This will redirect the user to `/loading/groups` once logged in successfully.

`POST /launch_lti_stats` This will redirect the user to `/loading/dashboard` once logged in successfully via LTI and OAuth. The LTI user id needs to be in the `adminCanvasUserIds` string.

`GET /json/stats` get statistics about authorized users and caches, JSON data. This data is used in the dashboard view.

The view `loading` is a proxy web page for displaying a progress bar until next page loads, as courses with many groupsets and groups can take some time to load. This page uses a html head http-equiv redirect.


## Storage and session cookies

This app uses `Sqlite3` for storing the user's access tokens for the Canvas API, once they have authorized the app in Canvas. Sessions are
kept in the same database, through the store in `session-store/`, and `express-session` sets the session cookie. Remember that the user needs
to accept third-party cookies as the app is loaded inline in Canvas.

Sessions used to be kept as one json file per session by `session-file-store`. That store rewrote the whole file on every request, including
the touch that a rolling cookie causes, and on Azure those files live on a network share. Overlapping read-modify-writes lost updates there,
which is how a session could come back without its access token. The sqlite store writes only the expiry column when a request has not
changed the session, so a request can no longer roll back what another one has just written. The database remains the source of truth for the
token, and it is read back whenever the session has nothing usable.


## Logging

Because of limitations with Azure file system logging we use Winston to write logs to `logs/logfiles` directory. The default is 50M logs rotated at max 10 files each.


## Special tricks

If you for some reason want to clear all sessions and authorized users, delete the database file in the `db/` folder. It holds both the
tokens and the sessions, and the tables are created again from the template on startup.


## Reading the database on Azure

The database is on the App Service filesystem, and it runs in WAL mode, so a copy of
`tokens.sqlite3` on its own is not the current state: recent writes live in `tokens.sqlite3-wal`
until sqlite checkpoints them. Copy all three files, or better, take a snapshot.

`VACUUM INTO` writes one self-contained file with everything committed, so there is a single
file to fetch and it is consistent even if the application writes while it runs. Node and the
sqlite3 module are already on the App Service, so from the Kudu console
(`https://<app>.scm.azurewebsites.net/DebugConsole`) in `site\wwwroot`:

```
node -e "const s=require('sqlite3');new s.Database('db/tokens.sqlite3').run(\"VACUUM INTO 'snapshot.sqlite3'\",e=>{console.log(e||'ok');process.exit(0)})"
```

Then download `snapshot.sqlite3` from the same console and open it locally. Delete it from the
server afterwards; it holds every user's refresh token.

The administration pages deliberately do not show token values, only a `sha256:` fingerprint
and the length, which is enough to see whether a token has changed. A refresh token is long
lived and gives full API access as the user, so it does not belong on a page or in a log.


## Database upgrades

An existing database file is used as it is; only missing tables are added, so the `sessions` table appears on the first startup after the
upgrade and the tokens are kept. The `tokens` table was created without a primary key before commit `ceb146d`, and `CREATE TABLE IF NOT
EXISTS` does not add one to a table that already exists, so a file that has been in place since then has no unique constraint on
`(user_id, user_env)`. On startup the missing constraint is created, after dropping any duplicate rows for the same key and keeping the one
written last. A database that already has its primary key is left untouched. Both cases are covered by tests in `test/`.


## About LTI

LTI (Learning Tools Interoperability®) provides a standard mechanism for authorizing users accessing a web-based application (Tool Provider) from another web-based application (Tool Consumer, typically an LMS). It can be seen as replacing a login page which a Tool Provider may otherwise have provided and avoids the need to distribute a username and password to each user. Instead a signed launch message is received from the Tool Consumer which can be verified and then trusted. This message should contain sufficient data from which to create user accounts and relevant resources (or resource mappings) "on-the-fly". Users gain a seamless experience without the need for any pre-provisioning, involvement of any other servers (for example, identity providers), or changing of any firewalls (message is sent through the user's browser). LTI works best when the Tool Provider delegates full responsibility for authorizing users to the Tool Consumer and does not allow users to directly access their system, thereby bypassing this authorization. This means that there is no need for the two systems to be synchronized with any changes to user privileges, so there is no risk of a user being given access to resources to which they are no longer entitled.


