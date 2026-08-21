'use strict';

require('dotenv').config({ quiet: true });
const path = require('node:path');
const winston = require('winston');

const logFormatConsole = winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.align(),
    winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`)
);

const logFormatFile = winston.format.combine(
    winston.format.timestamp(),
    winston.format.align(),
    winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`)
);

const logger = winston.createLogger({
    transports: [
        new winston.transports.Console({
            format: logFormatConsole
        }),
        new winston.transports.File({
            format: logFormatFile,
            filename: path.join(__dirname, 'logfiles/info.log'),
            level: 'info',
            maxsize: 5242880,
            maxFiles: 10
        }),
        new winston.transports.File({
            format: logFormatFile,
            filename: path.join(__dirname, 'logfiles/error.log'),
            level: 'error',
            maxsize: 5242880,
            maxFiles: 10
        })
    ]
});

const globalDebugMode = process.env.NODE_ENV === "development";

/* Writing a log entry is not an asynchronous operation, so these do not return a promise. */
/* They used to, which made every call site produce a promise that nobody waited for and  */
/* nobody handled if it rejected.                                                          */

const prefix = () => `[PID:${process.pid}][PPID:${process.ppid}]`;

exports.info = (msg) => {
    logger.info(`${prefix()} ${msg}`);
};

exports.debug = (msg) => {
    if (globalDebugMode) {
        logger.debug(`${prefix()} ${msg}`);
    }
};

exports.error = (msg) => {
    logger.error(`${prefix()} ${msg}`);
};
