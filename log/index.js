'use strict';

const winston = require('winston');
const path = require('path');

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

const globalDebugMode = false;

exports.info = async (msg) => new Promise(async function (resolve, reject) {
    try {
        const timestamp = new Date().toISOString();
        logger.info(`[PID:${process.pid}][PPID:${process.ppid}] ${msg}`);
        resolve(true);
    }
    catch (error) {
        reject(error);
    }
});

exports.debug = async (msg) => new Promise(async function (resolve, reject) {
    if (globalDebugMode) {
        try {
            const timestamp = new Date().toISOString();
            logger.debug(`[PID:${process.pid}][PPID:${process.ppid}] ${msg}`);
        }
        catch (error) {
            reject(error);
        }    
    }
    resolve(true);
});

exports.error = async (msg) => new Promise(async function (resolve, reject) {
    try {
        const timestamp = new Date().toISOString();
        logger.error(`[PID:${process.pid}][PPID:${process.ppid}] ${msg}`);
        resolve(true);
    }
    catch (error) {
        reject(error);
    }
});
