// ══════════════════════════════════════════════════════════════
// Logger estructurado minimal. JSON en stdout para info+, stderr
// para error. Filtrar con jq después.
// ══════════════════════════════════════════════════════════════

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL ?? "info").toLowerCase()] ?? LEVELS.info;

function emit(level, msg, extra) {
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra });
  (level === "error" ? console.error : console.log)(line);
}

export const log = {
  debug: (msg, extra) => emit("debug", msg, extra),
  info:  (msg, extra) => emit("info",  msg, extra),
  warn:  (msg, extra) => emit("warn",  msg, extra),
  error: (msg, extra) => emit("error", msg, extra),
};
