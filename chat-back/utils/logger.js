const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = LEVELS[process.env.LOG_LEVEL] ?? 2;

function log(level, msg, data = {}) {
  if (LEVELS[level] > currentLevel) return;
  const entry = { level, time: new Date().toISOString(), msg, ...data };
  (level === "error" ? console.error : console.log)(JSON.stringify(entry));
}

const logger = {
  info:  (msg, data) => log("info",  msg, data),
  warn:  (msg, data) => log("warn",  msg, data),
  error: (msg, data) => log("error", msg, data),
  debug: (msg, data) => log("debug", msg, data),
};

module.exports = logger;
