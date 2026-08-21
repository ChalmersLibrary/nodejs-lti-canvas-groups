# Canvas Group Tool

LTI Application for working with Canvas groups, groupsets and users using Node.js.


## Overview

This project is forked from https://github.com/js-kyle/nodejs-lti-provider which is the template for a minimal LTI provider
application written in Node.js by Kyle Martin.


## Requirements

Node.js 22 or later, which is what `engines` in `package.json` asks for. Development and production run 24, which is what `.nvmrc` says;
the whole test suite passes on 22 and 24 alike, so 22 stays available as a way back if a runtime upgrade goes wrong. The real floor is set by
the sqlite3 module at 20.17, but 22 is the oldest version this is actually tried on.


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

## Local development without Canvas

The tool normally gets everything it knows from an LTI launch, which needs Canvas. To work on it without that, copy the two example files
and set two variables:

```
cp .env.example .env
cp mock-lti.example.json mock-lti.json
```

In `.env` set `NODE_ENV=development` and `localCanvasDeveloperToken` to a Canvas API token of your own (Canvas: Account, Settings, New Access
Token). With both of those set, every request gets a session built from `mock-lti.json` as if that user had just launched the tool, so
`/groups` works straight away.

Which Canvas it talks to comes from `custom_canvas_api_domain` in `mock-lti.json`, which is honoured exactly as it would be from a real
launch. Leave `canvasBaseUri` unset unless you want to override that; it wins over the domain from the launch or the mock. The domain from a
launch is always used as `https://<domain>`, so `canvasBaseUri` is also the only way to point at something that is not https.

Those two settings also switch the session cookie to a first-party one, `SameSite=Lax` and not `Secure`, because in this mode the tool is
opened directly in a browser rather than in an iframe. The iframe cookie cannot be stored over plain http at all, so without this the cookie
would be dropped on every request; the mocked session is rebuilt each time so the tool would still work, but every page load would leave
another session row behind.

Fill `mock-lti.json` with values from a course you can actually see, or the API calls will come back empty. The simplest way to get real ones
is to set `debugLogging=true`, launch the tool from Canvas once, and copy the launch body out of `log/logfiles/info.log`.

Both `.env` and `mock-lti.json` are gitignored. The two example files are not, so keep real tokens and ids out of them.


## Launching from Canvas against localhost

The LTI launch is signed over the launch url as this application sees it, so the protocol,
host, port and path all have to match what Canvas signed. When they do not, the only thing
ims-lti says is `Invalid Signature`, which reads like a wrong shared secret. On a failure the
log now prints the url the signature was built over; compare that with the launch url
configured in Canvas.

The launch has to reach the application over **https**, and that is not a preference. The session
cookie is `SameSite=None`, because nothing else is sent from inside the Canvas iframe, and browsers
reject a `SameSite=None` cookie that is not also `Secure`. express-session will not put a `Secure`
cookie on a connection it does not consider https, so an iframed launch over plain
`http://localhost` stores no session at all: the launch succeeds, and then every request after it
starts a fresh empty session. That surfaces later as an OAuth redirect to `///login/oauth2/auth`,
or as the "third-party cookies" error, rather than as anything about cookies. The launch now logs
this when it happens.

So either put a tunnel in front of it, or, to work on everything except the launch itself, skip
Canvas and use `mock-lti.json` as described above.

Two things to know when Canvas reaches your machine through an https tunnel:

* Set `trustProxy=true`. Otherwise `req.protocol` is `http`, the signature is built over an
  `http://` url, and no shared secret can make it match.
* The tunnel has to pass the original `Host` header through. ims-lti builds the url from the
  `Host` header and never looks at `x-forwarded-host`, and `trustProxy` does not change that.

A query string in the configured launch url is worth avoiding too. For Canvas, ims-lti signs
the path only and drops the query, so a launch url with a query string can fail even when
everything else is right. Covered by `test/launch-signature.test.js`.


## Running in Azure App Service

Connect with Github or Bitbucket to your repository. When syncing, the build and install process should kick in and the app should be
available on the App Service URI shortly. That is one way; a GitHub Actions workflow or any other zip based deploy works as well.

Whichever you choose, decide where the sqlite database lives before you go live, because the default path is inside the directory a deploy
replaces. See [Moving the database off the deployment target](#moving-the-database-off-the-deployment-target).


## Environment variables / Azure application settings

[.env.example](.env.example) lists every variable the application reads, what it does and which ones are required. Copy it to `.env` for
local development and fill it in; in Azure the same names go in as App Service application settings. The example file is the authoritative
list, so that there is only one place to keep up to date.

The one worth singling out is `DB_PATH`, which in Azure should point outside `site/wwwroot`. See
[Moving the database off the deployment target](#moving-the-database-off-the-deployment-target).

**Node version in Azure.** Set `WEBSITE_NODE_DEFAULT_VERSION` to a Node 22 or later runtime, for example `~24`. An older note here said
12.13.0 because of trouble building the sqlite3 native module; that is no longer an issue, sqlite3 6 ships prebuilt binaries. Check that the
runtime you pick is actually available on your App Service plan before deploying, since the Windows flavour of App Service lags behind on
Node versions.


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

Because of limitations with Azure file system logging, Winston writes logs to the `logs/logfiles` directory. The default is 50M logs rotated at max 10 files each.

`debugLogging=true` adds the launch body and the session to the log, which is what you want when a launch misbehaves. The fields that
identify the person are written as `<redacted>`: `lis_person_sourcedid`, which depending on the SIS integration can carry a national
identity number, together with the name
fields, the email, the login id and the avatar url. The opaque `user_id` and `custom_canvas_user_id` are kept, since they are what the tokens
table is keyed on and a launch cannot be followed without them. Access tokens and refresh tokens are never logged at all.

Note that `username` is derived by ims-lti from `lis_person_name_given`, so it is redacted as well despite the innocent-looking name. If you
add a field to a session or a log line, check whether it belongs in `personalFields` in `lti/index.js`.


## Special tricks

The database holds three kinds of data and only two of them are throwaway:

| Table | What it is | Safe to lose? |
| --- | --- | --- |
| `sessions` | who is logged in right now | Yes, users go through a new LTI launch |
| `tokens` | Canvas API authorizations per user | Yes, users are asked to authorize once more |
| `self_signup_config` | the group rules teachers have set up per course | **No.** This is configuration and there is no copy of it anywhere |

So do not delete the database file to clear sessions or authorizations: it takes every configured self signup rule with it, and nobody
notices until a rule quietly stops applying. Delete from the table you actually mean:

```sql
DELETE FROM sessions;   -- log everyone out
DELETE FROM tokens;     -- send everyone through Canvas OAuth again
```

Both of those refill by themselves. If you do delete the whole file, it is recreated from the template on the next startup with empty tables,
and the self signup rules are gone for good.


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

Note that the administration pages, like the rest of the tool, need the session that the LTI
launch creates, and that session lives in the Canvas iframe. The session cookie is
`SameSite=None; Secure; Partitioned`, so browsers keep it in a jar belonging to the Canvas page
it was created under. Opening `/stats` or `/json/stats` directly in a browser tab is a different
context with no cookie, and the application answers that with the "third-party cookies" error
because from its point of view there is no session. Reach them from inside Canvas instead.


## Moving the database off the deployment target

By default the database lives at `db/tokens.sqlite3`, which is inside the application
directory. Whether it survives a deploy then depends entirely on how you deploy:

* A deploy that does a git checkout or fetch into the existing directory leaves untracked files
  where they are, so the database survives. This is the only arrangement in which the default
  path is safe.
* A zip deploy, which is what a GitHub Actions workflow normally does, unpacks the repository
  over the application directory on every run and takes the database with it.
* Run from package mounts the application directory read-only, so the application cannot write
  a database there at all.

Losing the file costs every user a reauthorization, which is silent and cheap, and every self
signup rule a teacher has configured, which is neither: nothing else holds a copy of those.

Set `DB_PATH` to somewhere outside whatever your deploy replaces and the question goes away. On
Azure App Service that means a path under `/home` other than `/home/site`, for example
`/home/Data/<something>/grouptool.sqlite`; `/home` is persistent storage that survives deploys
and restarts. It is one app setting, with no code change.

Do it in this order, because the application creates an empty database from
`db/tokens_template.sqlite3` whenever the path does not exist, and would otherwise come up
looking factory fresh with the real data still at the old path:

1. Snapshot the current database with `VACUUM INTO`, not `cp`, since a plain copy misses
   whatever is still in the `-wal` file. See the section above. The snapshot is a single file:
   `-wal` and `-shm` are runtime files rather than part of the database, and `VACUUM INTO`
   writes everything into the one output file. They reappear when the application opens it.
2. Put the snapshot at the new path and check it is readable.
3. Set `DB_PATH` to the full path of the file and restart.

Use a subdirectory of your own rather than the share root, so that the file is not mixed in
with what Azure puts there: `DB_PATH=/home/Data/grouptool/tokens.sqlite3`.

Mind the capitalisation, and write the path the way `ls` shows it. The `/home` mount on App
Service has been observed to be case-insensitive but case-preserving, so `/home/data` and
`/home/Data` reached the same directory, but that is a property of the mount rather than of this
application, which uses the path exactly as given. The canonical spelling is the one that keeps
working if the path is ever read somewhere case-sensitive.

The directory has to exist; the application will not create one, and says which directory is
missing rather than failing with an ENOENT from the template copy.


## Journal mode

The database runs in WAL mode, which is what makes sqlite workable on the Azure network share;
without it concurrent requests produce "database is locked". It used to be inherited from
`db/tokens_template.sqlite3`, which only covers a database the application created itself.

`VACUUM INTO` writes its output in the default rollback journal mode, so a snapshot taken to
move the database arrives as `journal_mode=delete` and would quietly lose the workaround. On
startup the mode is therefore read, and switched only if it is not already WAL:

```
[DB] Journal mode is WAL.                                  nothing to do
[DB] Journal mode is 'delete', trying to switch to WAL.     followed by one of
[DB] Journal mode is now WAL.
[DB] Could not switch to WAL, still 'delete'. ...
```

The template carries the mode pre-set because the switch has been reported not to take on a
cifs mount, which is where the template trick comes from. It has since been observed to work on
an App Service share, so the pre-set template is belt and braces rather than the only route.
Since that is one observation and not a guarantee, the mode is written only when it is actually
wrong, and the outcome is logged rather than assumed.

If `Could not switch to WAL` does appear, set the mode on a copy of the file on a local
filesystem, where the switch is reliable, and put that copy in place. The setting lives in the
file header and travels with the file, which is exactly what the template relies on.


## Database upgrades

An existing database file is used as it is; only missing tables are added, so the `sessions` table appears on the first startup after the
upgrade and the tokens are kept. The `tokens` table was created without a primary key before commit `ceb146d`, and `CREATE TABLE IF NOT
EXISTS` does not add one to a table that already exists, so a file that has been in place since then has no unique constraint on
`(user_id, user_env)`. On startup the missing constraint is created, after dropping any duplicate rows for the same key and keeping the one
written last. A database that already has its primary key is left untouched. Both cases are covered by tests in `test/`.


## About LTI

LTI (Learning Tools Interoperability®) provides a standard mechanism for authorizing users accessing a web-based application (Tool Provider) from another web-based application (Tool Consumer, typically an LMS). It can be seen as replacing a login page which a Tool Provider may otherwise have provided and avoids the need to distribute a username and password to each user. Instead a signed launch message is received from the Tool Consumer which can be verified and then trusted. This message should contain sufficient data from which to create user accounts and relevant resources (or resource mappings) "on-the-fly". Users gain a seamless experience without the need for any pre-provisioning, involvement of any other servers (for example, identity providers), or changing of any firewalls (message is sent through the user's browser). LTI works best when the Tool Provider delegates full responsibility for authorizing users to the Tool Consumer and does not allow users to directly access their system, thereby bypassing this authorization. This means that there is no need for the two systems to be synchronized with any changes to user privileges, so there is no risk of a user being given access to resources to which they are no longer entitled.


