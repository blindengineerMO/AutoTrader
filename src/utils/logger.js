const winston = require('winston');
const path = require('path');
const { config } = require('../config');

const logsDir = path.join(__dirname, '..', '..', 'logs');

const logger = winston.createLogger({
  level: config.logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'autotrader' },
  transports: [
    new winston.transports.File({ filename: path.join(logsDir, 'error.log'), level: 'error' }),
    new winston.transports.File({ filename: path.join(logsDir, 'combined.log') }),
  ],
});

if (config.env !== 'production') {
  logger.add(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const rest = Object.keys(meta).filter((k) => k !== 'service');
          const extra = rest.length ? ` ${JSON.stringify(Object.fromEntries(rest.map((k) => [k, meta[k]])))}` : '';
          return `${timestamp} ${level} ${message}${extra}`;
        })
      ),
    })
  );
}

module.exports = logger;
