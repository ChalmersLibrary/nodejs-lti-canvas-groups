'use strict';

const errorMap = new Map([
    [ 10, "Database error." ],
    [ 20, "LTI communication error, the session is not valid." ],
    [ 30, "OAuth communication error." ],
    [ 41, "Your browser must allow cookies from third parties. In Safari preferences under privacy, it's called cross-site tracking." ],
    [ 42, "This page is only visible to listed administrators." ]
]);

/* A lookup in a Map is not asynchronous, so this does not return a promise. */
exports.errorDescription = (id) => errorMap.get(parseInt(id, 10)) ?? "Unknown error.";
