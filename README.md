# Canvas Group Tool

LTI Application for working with Canvas groups, groupsets and users using Node.js.


## Overview

This project is forked from https://github.com/js-kyle/nodejs-lti-provider which is the template for a minimal LTI provider
application written in Node.js by Kyle Martin.


## Installation

```
# Install dependencies using npm
$ npm install

# Run the app
$ npm start

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

**Important!** `WEBSITE_NODE_DEFAULT_VERSION` in Chalmers' production environment is set to **12.13.0** due to some limitations in compiling SqlLite3 modules when running higher versions of node. Not sure what this problem is and I'll look into it later.



## Integrating in Canvas

You must first create a Developer Key for this application, then store the values in environment variables `oauthClientId` and `oauthClientSecret`. Then, add the application as a LTI Application to Canvas. Use the XML in [conf-lti-template.xml](https://github.com/ChalmersLibrary/nodejs-lti-canvas-groups/blob/27948de93c6bd83901985bd75d1da0ac45080c81/conf-lti-template.xml) and fill out the correct Consumer Key and Secret, which you store in environment variable `ltiConsumerKeys`. The main LTI Launch point is `/launch_lti`.


## Usage

`GET /` check the application availability and version, JSON data.

`POST /launch_lti` LTI launch URL. This receives a `application/x-www-form-urlencoded` POST request, with the parameters passed according to the LTI specification. This will redirect the user to `/loading/groups` once logged in successfully.

`POST /launch_lti_stats` This will redirect the user to `/loading/dashboard` once logged in successfully via LTI and OAuth. The LTI user id needs to be in the `adminCanvasUserIds` string.

`GET /json/stats` get statistics about authorized users and caches, JSON data. This data is used in the dashboard view.

The view `loading` is a proxy web page for displaying a progress bar until next page loads, as courses with many groupsets and groups can take some time to load. This page uses a html head http-equiv redirect.


## Storage and session cookies

This app uses `Sqlite3` for storing user's access tokens for Canvas API, once they have authorized the app in Canvas. For connecting this
data the module `express-session` is used to set session cookies, where the data is stored in the file system. Remember that the user needs 
to accept third-party cookies as the app is loaded inline in Canvas.


## Logging

Because of limitations with Azure file system logging we use Winston to write logs to `logs/logfiles` directory. The default is 50M logs rotated at max 10 files each.


## Special tricks

If you for some reason want to clear all sessions and authorized users, first delete all session files and then delete the database file
in the `db/` folder. When the system detects an error in Sqlite query, the main table will be created again.


## About LTI

LTI (Learning Tools Interoperability®) provides a standard mechanism for authorizing users accessing a web-based application (Tool Provider) from another web-based application (Tool Consumer, typically an LMS). It can be seen as replacing a login page which a Tool Provider may otherwise have provided and avoids the need to distribute a username and password to each user. Instead a signed launch message is received from the Tool Consumer which can be verified and then trusted. This message should contain sufficient data from which to create user accounts and relevant resources (or resource mappings) "on-the-fly". Users gain a seamless experience without the need for any pre-provisioning, involvement of any other servers (for example, identity providers), or changing of any firewalls (message is sent through the user's browser). LTI works best when the Tool Provider delegates full responsibility for authorizing users to the Tool Consumer and does not allow users to directly access their system, thereby bypassing this authorization. This means that there is no need for the two systems to be synchronized with any changes to user privileges, so there is no risk of a user being given access to resources to which they are no longer entitled.


