import { config } from "./config.mjs";
import { log } from "./logger.mjs";
import { scrapeProduct } from "./scraper.mjs";
import { saveDataNow, getState, setProduct, deleteProduct } from "./storage.mjs";
import { sanitizeAmazonURL, sleep, escapeMD, currencyFromUrl } from "./utils.mjs";

// ══════════════════════════════════════════════════════════════
// Chequeo de precios de todos los productos.
//
// Mutex simple para evitar que el cron + /check simultáneos disparen
// dos runs que muten priceData a la vez (last-write-wins → lost update).
// ══════════════════════════════════════════════════════════════

let running = false;

export function isCheckRunning() { return running; }

/**
 * @param {(msg: string, opts?: object) => Promise<any>} notify - función que envía a Telegram
 * @param {number[]} chatIds - a quiénes notificar
 * @returns {Promise<{checked:number, dropped:number, errors:number}>}
 */
export async function checkPrices(notify, chatIds) {
  if (running) {
    log.warn("checkPrices already running, skipping");
    return { checked: 0, dropped: 0, errors: 0 };
  }
  running = true;

  const state = getState();
  const keys = Object.keys(state.products);
  const summary = { checked: 0, dropped: 0, errors: 0 };

  try {
    if (!keys.length) {
      log.info("no products to check");
      return summary;
    }
    log.info("price check start", { products: keys.length });

    const changed = [];

    for (const key of keys) {
      const stored = state.products[key];
      if (!stored) continue;

      const sanitized = sanitizeAmazonURL(stored.url || key);
      const scraped = await scrapeProduct(sanitized);
      summary.checked++;

      if (scraped.error) {
        log.warn("scrape failed", { key, error: scraped.error });
        stored.lastChecked = new Date().toISOString();
        stored.lastError   = scraped.error;
        summary.errors++;
        await sleep(config.scrapePauseMs);
        continue;
      }

      const prevPrice   = typeof stored.price === "number"       ? stored.price       : scraped.price;
      const prevLowest  = typeof stored.lowestPrice === "number" ? stored.lowestPrice : scraped.price;
      const newLowest   = Math.min(scraped.price, prevLowest);

      const updated = {
        url:          sanitized,
        title:        scraped.title,
        price:        scraped.price,
        imageUrl:     scraped.imageUrl ?? stored.imageUrl ?? null,
        currency:     stored.currency ?? currencyFromUrl(sanitized),
        lastChecked:  new Date().toISOString(),
        addedDate:    stored.addedDate ?? new Date().toISOString(),
        addedBy:      stored.addedBy ?? null,
        lowestPrice:  newLowest,
        history:      Array.isArray(stored.history) ? [...stored.history] : [],
        lastError:    null,
      };
      updated.history.push({ date: updated.lastChecked, price: scraped.price });
      if (updated.history.length > config.historyLimit) {
        updated.history = updated.history.slice(-config.historyLimit);
      }

      // Notificar SOLO si bajó respecto al último precio Y quedó en/bajo mínimo histórico.
      // Antes: notificaba en cualquier bajada respecto al anterior → ruido si el precio
      // oscilaba arriba del histórico.
      if (scraped.price < prevPrice && scraped.price <= prevLowest) {
        const diff = (prevPrice - scraped.price).toFixed(2);
        const pct  = (((prevPrice - scraped.price) / prevPrice) * 100).toFixed(1);
        const cur  = updated.currency;
        changed.push({
          url: sanitized,
          imageUrl: updated.imageUrl,
          message:
`🚨 ¡Precio reducido!

*${escapeMD(updated.title)}*

💰 Precio anterior: ${cur} ${prevPrice}
🎯 Precio actual: ${cur} ${scraped.price}
💵 Ahorro: ${cur} ${diff} (${pct}% menos)
📉 Histórico más bajo: ${cur} ${newLowest}

[Ver en Amazon](${sanitized})`,
        });
        summary.dropped++;
      }

      setProduct(sanitized, updated);
      if (sanitized !== key) deleteProduct(key);
      await sleep(config.scrapePauseMs);
    }

    await saveDataNow();
    log.info("price check done", summary);

    for (const chatId of chatIds) {
      for (const p of changed) {
        try {
          if (p.imageUrl) {
            await notify(chatId, "photo", p.imageUrl, {
              caption:     p.message,
              parse_mode:  "Markdown",
              reply_markup: { inline_keyboard: [[{ text: "🛒 Ver en Amazon", url: p.url }]] },
            });
          } else {
            await notify(chatId, "text", p.message, {
              parse_mode:  "Markdown",
              reply_markup: { inline_keyboard: [[{ text: "🛒 Ver en Amazon", url: p.url }]] },
            });
          }
          await sleep(400);
        } catch (err) {
          log.error("notify failed", { chatId, error: err.message });
        }
      }
    }

    return summary;
  } finally {
    running = false;
  }
}
