import "dotenv/config";

// ══════════════════════════════════════════════════════════════
// Config parseada del entorno. Fail-fast si algo requerido falta.
// ══════════════════════════════════════════════════════════════

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`❌ Missing required env: ${name}`);
    process.exit(1);
  }
  return v;
}

function optionalInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) { console.error(`❌ Invalid ${name}: ${raw}`); process.exit(1); }
  return n;
}

function parseIdList(raw) {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => !Number.isNaN(n));
}

const TELEGRAM_TOKEN = required("TELEGRAM_TOKEN");
if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(TELEGRAM_TOKEN)) {
  console.error("❌ TELEGRAM_TOKEN looks malformed (expected `<numericId>:<secret>`)");
  process.exit(1);
}

export const config = {
  telegramToken:   TELEGRAM_TOKEN,
  dataFile:        process.env.DATA_FILE ?? "prices.json",

  // Allowlist de chats owners. Si está vacío, permite cualquier chat (dev mode).
  // Para producción SIEMPRE poner al menos un id (obtén el tuyo enviando /start
  // al bot @userinfobot en Telegram).
  ownerChatIds:    new Set(parseIdList(process.env.OWNER_CHAT_IDS)),

  historyLimit:    optionalInt("HISTORY_LIMIT", 120),
  checkIntervalCron: process.env.CHECK_CRON  ?? "0 */2 * * *",
  summaryCron:     process.env.SUMMARY_CRON  ?? "0 20 * * *",

  playwrightTimeoutMs: optionalInt("PLAYWRIGHT_TIMEOUT_MS", 60_000),
  scrapePauseMs:       optionalInt("SCRAPE_PAUSE_MS", 900),

  // Directorio para cookies + localStorage persistentes (contexto persistente
  // = Amazon confía más en sesiones que ya visitaron el site). Empty → in-memory.
  userDataDir:         process.env.USER_DATA_DIR ?? ".browser-profile",

  // Reintentos ante fallo tipo captcha. `retryDelayMs` es el delay base;
  // se aplica exponencial (delay * 2^i) hasta `maxRetries`.
  scrapeRetries:       optionalInt("SCRAPE_RETRIES", 2),
  scrapeRetryDelayMs:  optionalInt("SCRAPE_RETRY_DELAY_MS", 30_000),

  // User-Agent moderno para minimizar detección como bot.
  userAgent: process.env.USER_AGENT ??
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};
