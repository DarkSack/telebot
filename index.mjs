import TelegramBot from "node-telegram-bot-api";
import cron from "node-cron";
import { config } from "./src/config.mjs";
import { log } from "./src/logger.mjs";
import { loadData, listChats } from "./src/storage.mjs";
import { checkPrices } from "./src/priceCheck.mjs";
import { closeBrowser } from "./src/scraper.mjs";
import { registerHandlers, sendDailySummary } from "./src/handlers.mjs";

// ══════════════════════════════════════════════════════════════
// Bootstrap del bot: carga datos → arranca telegram polling →
// registra handlers → schedule crons → graceful shutdown.
// ══════════════════════════════════════════════════════════════

async function main() {
  await loadData();

  const bot = new TelegramBot(config.telegramToken, { polling: true });
  const { notify } = registerHandlers(bot);

  cron.schedule(config.summaryCron, async () => {
    log.info("cron: daily summary");
    await sendDailySummary(bot);
  });

  cron.schedule(config.checkIntervalCron, async () => {
    log.info("cron: price check");
    try { await checkPrices(notify, listChats()); }
    catch (err) { log.error("cron price check failed", { error: err.message }); }
  });

  log.info("bot ready", {
    owners:   config.ownerChatIds.size === 0 ? "public (dev mode)" : [...config.ownerChatIds],
    checkCron: config.checkIntervalCron,
    summaryCron: config.summaryCron,
  });

  // Graceful shutdown
  const stop = async (sig) => {
    log.info(`${sig} received, shutting down`);
    try { await bot.stopPolling(); } catch {}
    try { await closeBrowser(); } catch {}
    process.exit(0);
  };
  process.on("SIGINT",  () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

main().catch((err) => {
  log.error("fatal", { error: err.message, stack: err.stack });
  process.exit(1);
});
