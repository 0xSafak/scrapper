const levels = { debug: 0, info: 1, warn: 2, error: 3 };
let minLevel = levels.info;

export function setLogLevel(level) {
  if (levels[level] !== undefined) minLevel = levels[level];
}

export function log(level, message, data = null) {
  if (levels[level] == null || levels[level] < minLevel) return;
  const ts = new Date().toISOString();
  const payload = { timestamp: ts, level, message };
  if (data != null) payload.data = data;
  const line = `${ts} [${level.toUpperCase()}] ${message}` + (data ? ` ${JSON.stringify(data)}` : '');
  if (level === 'error') console.error(line);
  else console.log(line);
}

export const logger = {
  debug: (msg, data) => log('debug', msg, data),
  info: (msg, data) => log('info', msg, data),
  warn: (msg, data) => log('warn', msg, data),
  error: (msg, data) => log('error', msg, data),
};

export default logger;
