import { config } from "./config.mjs";
import { log } from "./logger.mjs";
import { escapeMD, sanitizeAmazonURL, truncate, currencyFromUrl } from "./utils.mjs";
import {
  getState, getProduct, setProduct, deleteProduct,
  registerChat, listChats, saveDataDebounced, saveDataNow, listProductKeys,
} from "./storage.mjs";
import { scrapeProduct } from "./scraper.mjs";
import { generateChartBuffer } from "./chart.mjs";
import { checkPrices, isCheckRunning } from "./priceCheck.mjs";

// ══════════════════════════════════════════════════════════════
// Handlers de Telegram — commands + inline callbacks.
// Aisla al `bot` en un único módulo para que el resto de la codebase
// no dependa de node-telegram-bot-api directamente.
// ══════════════════════════════════════════════════════════════

/**
 * Devuelve true si el chat está autorizado. Sin allowlist → todos.
 * Con allowlist → solo owners.
 */
function isOwner(chatId) {
  if (config.ownerChatIds.size === 0) return true;
  return config.ownerChatIds.has(chatId);
}

/** Adapter que expone `notify(chatId, kind, payload, opts)` al priceCheck. */
function makeNotifier(bot) {
  return (chatId, kind, payload, opts) => {
    if (kind === "photo") return bot.sendPhoto(chatId, payload, opts);
    return bot.sendMessage(chatId, payload, opts);
  };
}

export function registerHandlers(bot) {
  const notify = makeNotifier(bot);

  // Middleware: guard owner-only. Devuelve false si bloquea.
  async function guardOwner(msg) {
    if (isOwner(msg.chat.id)) return true;
    log.warn("unauthorized access", { chatId: msg.chat.id, username: msg.chat.username });
    await bot.sendMessage(msg.chat.id, "🔒 Bot privado. No estás autorizado.");
    return false;
  }

  // Auto-register de chats owners (solo si están en la allowlist).
  bot.on("message", (msg) => {
    if (!isOwner(msg.chat.id)) return;
    if (registerChat(msg.chat.id)) {
      log.info("new chat registered", { chatId: msg.chat.id });
      saveDataDebounced();
    }
  });

  // ── /start ────────────────────────────────────────────
  bot.onText(/^\/start$/, async (msg) => {
    if (!(await guardOwner(msg))) return;
    await bot.sendMessage(msg.chat.id,
`🤖 ¡Hola! Soy tu bot rastreador de precios.

*Comandos:*
📦 /add <url> - Añadir producto
🔍 /check - Revisar precios ahora
📝 /list - Ver productos en seguimiento
🗑️ /remove <url> - Eliminar producto
✏️ /edit <url_actual> <url_nueva> - Actualizar URL
📊 /stats - Ver estadísticas
📈 /chart <url> - Gráfico del historial
❓ /help - Mostrar ayuda`, { parse_mode: "Markdown" });
  });

  // ── /help ─────────────────────────────────────────────
  bot.onText(/^\/help$/, async (msg) => {
    if (!(await guardOwner(msg))) return;
    await bot.sendMessage(msg.chat.id,
`📖 *Guía rápida*

/add https://... - Agrega producto
/check - Forzar revisión
/list - Ver productos
/remove <url> - Eliminar
/edit <url_actual> <url_nueva> - Actualizar URL
/stats - Estadísticas
/chart <url> - Gráfico del historial`, { parse_mode: "Markdown" });
  });

  // ── /add ──────────────────────────────────────────────
  bot.onText(/^\/add(?:\s+(.+))?$/, async (msg, match) => {
    if (!(await guardOwner(msg))) return;
    const raw = match?.[1]?.trim();
    if (!raw) {
      await bot.sendMessage(msg.chat.id, "❌ Uso: `/add <URL de Amazon>`", { parse_mode: "Markdown" });
      return;
    }
    if (!/^https?:\/\//i.test(raw)) {
      await bot.sendMessage(msg.chat.id, "❌ URL inválida. Debe iniciar con http(s).");
      return;
    }
    const sanitized = sanitizeAmazonURL(raw);
    if (getProduct(sanitized)) {
      const existing = getProduct(sanitized);
      await bot.sendMessage(msg.chat.id,
        `⚠️ Este producto ya está en seguimiento:\n*${escapeMD(existing.title ?? sanitized)}*`,
        { parse_mode: "Markdown" });
      return;
    }

    const loading = await bot.sendMessage(msg.chat.id, "⏳ Obteniendo información del producto...");

    const scraped = await scrapeProduct(sanitized);
    if (scraped.error) {
      await bot.editMessageText(
        `❌ No se pudo obtener información del producto: ${scraped.error}`,
        { chat_id: msg.chat.id, message_id: loading.message_id });
      return;
    }

    const now = new Date().toISOString();
    setProduct(sanitized, {
      url: sanitized,
      title: scraped.title,
      price: scraped.price,
      lowestPrice: scraped.price,
      imageUrl: scraped.imageUrl,
      currency: currencyFromUrl(sanitized),
      addedDate: now,
      addedBy: msg.chat.id,
      lastChecked: now,
      lastError: null,
      history: [{ date: now, price: scraped.price }],
    });
    await saveDataNow();

    const successText =
`✅ *Producto agregado exitosamente*

📦 ${escapeMD(scraped.title)}
💰 Precio actual: ${currencyFromUrl(sanitized)} ${scraped.price}
📅 Agregado: ${new Date().toLocaleDateString()}

🔔 Te notificaré cuando baje el precio.`;

    const keyboard = {
      inline_keyboard: [[
        { text: "🛒 Ver en Amazon", url: sanitized },
        { text: "📝 Ver todos", callback_data: "list" },
      ]],
    };

    // Si tenemos imagen: borrar el "⏳ obteniendo…" y mandar photo con caption.
    // Si no: solo editar el texto (que ya está allí).
    if (scraped.imageUrl) {
      await bot.deleteMessage(msg.chat.id, loading.message_id).catch(() => {});
      await bot.sendPhoto(msg.chat.id, scraped.imageUrl, {
        caption: successText, parse_mode: "Markdown", reply_markup: keyboard,
      });
    } else {
      await bot.editMessageText(successText, {
        chat_id: msg.chat.id, message_id: loading.message_id,
        parse_mode: "Markdown", reply_markup: keyboard,
      });
    }
  });

  // ── /check ────────────────────────────────────────────
  bot.onText(/^\/check$/, async (msg) => {
    if (!(await guardOwner(msg))) return;
    if (isCheckRunning()) {
      await bot.sendMessage(msg.chat.id, "⏳ Ya hay una revisión en curso, espera a que termine.");
      return;
    }
    const loading = await bot.sendMessage(msg.chat.id,
      "⏳ Revisando precios de todos los productos... (esto puede tardar)");
    try {
      const s = await checkPrices(notify, listChats());
      await bot.editMessageText(
        `✅ Revisión completada · ${s.checked} productos · ${s.dropped} bajadas · ${s.errors} errores`,
        { chat_id: msg.chat.id, message_id: loading.message_id });
    } catch (err) {
      log.error("/check failed", { error: err.message });
      await bot.editMessageText("❌ Ocurrió un error durante la revisión.",
        { chat_id: msg.chat.id, message_id: loading.message_id });
    }
  });

  // ── /list ─────────────────────────────────────────────
  bot.onText(/^\/list$/, async (msg) => {
    if (!(await guardOwner(msg))) return;
    await sendList(bot, msg.chat.id);
  });

  // ── /stats ────────────────────────────────────────────
  bot.onText(/^\/stats$/, async (msg) => {
    if (!(await guardOwner(msg))) return;
    const state = getState();
    const total = Object.keys(state.products).length;
    if (total === 0) {
      await bot.sendMessage(msg.chat.id, "📊 No tienes productos en seguimiento.");
      return;
    }
    // Cuenta productos cuyo precio actual está al mínimo histórico (=oferta ahora).
    // El código anterior comparaba `price < lowestPrice` — matemáticamente imposible.
    let atLowest = 0;
    let cumulativeSavings = 0;
    for (const p of Object.values(state.products)) {
      if (typeof p.price !== "number") continue;
      const initial = p.history?.[0]?.price ?? p.price;
      cumulativeSavings += Math.max(0, initial - p.price);
      if (typeof p.lowestPrice === "number" && p.price === p.lowestPrice) atLowest++;
    }
    await bot.sendMessage(msg.chat.id,
`📊 *Estadísticas de seguimiento*

📦 Productos: ${total}
👥 Chats registrados: ${state.chats.size}
📉 En mínimo histórico ahora: ${atLowest}
💰 Ahorro acumulado (vs precio inicial): ${cumulativeSavings.toFixed(2)}`, { parse_mode: "Markdown" });
  });

  // ── /remove ───────────────────────────────────────────
  bot.onText(/^\/remove\s+(.+)$/, async (msg, match) => {
    if (!(await guardOwner(msg))) return;
    const raw = match[1].trim();
    const sanitized = sanitizeAmazonURL(raw);

    let key = sanitized;
    let product = getProduct(key);
    if (!product) {
      // Búsqueda parcial defensiva (usa title solo si existe).
      key = listProductKeys().find(k =>
        k.includes(raw) || (getProduct(k)?.title ?? "").includes(raw)) ?? null;
      product = key ? getProduct(key) : null;
    }

    if (!product) {
      await bot.sendMessage(msg.chat.id, "⚠️ No se encontró producto con esa URL. Usa /list");
      return;
    }
    deleteProduct(key);
    await saveDataNow();
    await bot.sendMessage(msg.chat.id,
      `🗑️ *Producto eliminado:*\n${escapeMD(product.title ?? key)}`, { parse_mode: "Markdown" });
  });

  // ── /edit ─────────────────────────────────────────────
  bot.onText(/^\/edit\s+(\S+)\s+(\S+)$/, async (msg, match) => {
    if (!(await guardOwner(msg))) return;
    const oldKey = sanitizeAmazonURL(match[1].trim());
    const newKey = sanitizeAmazonURL(match[2].trim());
    const prev = getProduct(oldKey);
    if (!prev) {
      await bot.sendMessage(msg.chat.id, "⚠️ No se encontró producto con la URL original. Usa /list");
      return;
    }
    const loading = await bot.sendMessage(msg.chat.id, "⏳ Actualizando producto...");
    const scraped = await scrapeProduct(newKey);
    if (scraped.error) {
      await bot.editMessageText(
        `❌ No se pudo obtener info de la nueva URL: ${scraped.error}`,
        { chat_id: msg.chat.id, message_id: loading.message_id });
      return;
    }
    const now = new Date().toISOString();
    const lowest = typeof prev.lowestPrice === "number"
      ? Math.min(prev.lowestPrice, scraped.price)
      : scraped.price;
    const updated = {
      url: newKey,
      title: scraped.title,
      price: scraped.price,
      lowestPrice: lowest,
      imageUrl: scraped.imageUrl ?? prev.imageUrl,
      currency: prev.currency ?? currencyFromUrl(newKey),
      addedDate: prev.addedDate ?? now,
      addedBy: prev.addedBy ?? msg.chat.id,
      lastChecked: now,
      lastError: null,
      history: Array.isArray(prev.history) ? [...prev.history, { date: now, price: scraped.price }] : [{ date: now, price: scraped.price }],
    };
    if (updated.history.length > config.historyLimit) {
      updated.history = updated.history.slice(-config.historyLimit);
    }
    setProduct(newKey, updated);
    if (oldKey !== newKey) deleteProduct(oldKey);
    await saveDataNow();

    await bot.editMessageText(
      `✅ *Producto actualizado*\n\nAntes: ${escapeMD(prev.title ?? oldKey)}\nAhora: ${escapeMD(scraped.title)}`,
      { chat_id: msg.chat.id, message_id: loading.message_id, parse_mode: "Markdown" });
  });

  // ── /chart ────────────────────────────────────────────
  bot.onText(/^\/chart\s+(.+)$/, async (msg, match) => {
    if (!(await guardOwner(msg))) return;
    const key = sanitizeAmazonURL(match[1].trim());
    await sendChart(bot, msg.chat.id, key);
  });

  // ── Callbacks (inline buttons) ────────────────────────
  bot.on("callback_query", async (cb) => {
    const chatId = cb.message.chat.id;
    if (!isOwner(chatId)) {
      await bot.answerCallbackQuery(cb.id, { text: "No autorizado" }).catch(() => {});
      return;
    }
    await bot.answerCallbackQuery(cb.id).catch(() => {});
    try {
      const data = cb.data;
      if (data.startsWith("select_product:")) return showProduct(bot, chatId, data.substring("select_product:".length));
      if (data.startsWith("delete_product:")) return removeAndReshow(bot, chatId, data.substring("delete_product:".length));
      if (data.startsWith("edit_product:")) {
        const url = data.substring("edit_product:".length);
        return bot.sendMessage(chatId, `✍🏻 Para editar la URL usa:\n\`/edit ${url} <nueva_url>\``, { parse_mode: "Markdown" });
      }
      if (data.startsWith("chart:")) return sendChart(bot, chatId, data.substring("chart:".length));
      if (data === "delete_all") return handleDeleteAll(bot, chatId);
      if (data === "list") return sendList(bot, chatId);
      if (data === "check_prices") {
        if (isCheckRunning()) return bot.sendMessage(chatId, "⏳ Ya hay una revisión en curso.");
        const loading = await bot.sendMessage(chatId, "⏳ Iniciando revisión de precios...");
        const s = await checkPrices(notify, listChats());
        return bot.editMessageText(
          `✅ Revisión completada · ${s.checked} · ${s.dropped} bajadas · ${s.errors} errores`,
          { chat_id: chatId, message_id: loading.message_id });
      }
      await bot.sendMessage(chatId, "Comando inline no reconocido.");
    } catch (err) {
      log.error("callback error", { error: err.message });
      await bot.sendMessage(chatId, "❌ Ocurrió un error procesando la acción.");
    }
  });

  // ── Bot-level errors ───────────────────────────────────
  bot.on("polling_error", (err) => log.error("polling error", { error: err?.message ?? err }));
  bot.on("error",         (err) => log.error("bot error",     { error: err?.message ?? err }));

  return { notify };
}

// ── Helpers de UI ─────────────────────────────────────────

async function sendList(bot, chatId) {
  const keys = listProductKeys();
  if (!keys.length) {
    return bot.sendMessage(chatId, "📭 No tienes productos en seguimiento.\n\nUsa `/add <url>` para agregar uno.", { parse_mode: "Markdown" });
  }
  const inlineKeyboard = keys.map((u) => {
    const p = getProduct(u);
    return [{ text: `📦 ${truncate(p?.title ?? u, 30)}`, callback_data: `select_product:${u}` }];
  });
  inlineKeyboard.push([{ text: "🗑️ Eliminar todos", callback_data: "delete_all" }]);
  inlineKeyboard.push([{ text: "🔄 Revisar precios ahora", callback_data: "check_prices" }]);

  await bot.sendMessage(chatId,
    `📊 *Productos en seguimiento: ${keys.length}*\n\nSelecciona uno para ver detalles:`,
    { parse_mode: "Markdown", reply_markup: { inline_keyboard: inlineKeyboard } });
}

async function showProduct(bot, chatId, url) {
  const p = getProduct(url);
  if (!p) return bot.sendMessage(chatId, "❌ Producto no encontrado.");

  const addedDate = p.addedDate ? new Date(p.addedDate).toLocaleDateString() : "N/A";
  const lastChecked = p.lastChecked ? new Date(p.lastChecked).toLocaleDateString() : "Nunca";
  const initial = p.history?.[0]?.price ?? p.price;
  const savings = initial - p.price;
  const savingsText = savings > 0 ? `\n💰 Ahorro vs precio inicial: ${p.currency ?? ""} ${savings.toFixed(2)}` : "";
  const errText = p.lastError ? `\n⚠️ Último error: ${escapeMD(p.lastError)}` : "";
  const cur = p.currency ?? "";

  const text =
`*${escapeMD(p.title)}*

💰 Precio actual: ${cur} ${p.price}
📉 Precio más bajo visto: ${cur} ${p.lowestPrice}
📅 Agregado: ${addedDate}
🔄 Última revisión: ${lastChecked}${savingsText}${errText}`;

  const keyboard = {
    inline_keyboard: [
      [{ text: "🛒 Ver en Amazon", url: p.url }],
      [
        { text: "✍🏻 Editar URL", callback_data: `edit_product:${url}` },
        { text: "🗑️ Eliminar",   callback_data: `delete_product:${url}` },
      ],
      [{ text: "⏪ Volver a la lista", callback_data: "list" }],
      [{ text: "📈 Ver gráfico",       callback_data: `chart:${url}` }],
    ],
  };
  if (p.imageUrl) {
    await bot.sendPhoto(chatId, p.imageUrl, { caption: text, parse_mode: "Markdown", reply_markup: keyboard });
  } else {
    await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: keyboard });
  }
}

async function removeAndReshow(bot, chatId, url) {
  const p = getProduct(url);
  if (p) {
    deleteProduct(url);
    await saveDataNow();
    await bot.sendMessage(chatId, `🗑️ *Producto eliminado:*\n${escapeMD(p.title ?? url)}`, { parse_mode: "Markdown" });
  } else {
    await bot.sendMessage(chatId, "❌ Producto no encontrado.");
  }
  await sendList(bot, chatId);
}

async function handleDeleteAll(bot, chatId) {
  const total = listProductKeys().length;
  for (const k of listProductKeys()) deleteProduct(k);
  await saveDataNow();
  await bot.sendMessage(chatId, `🗑️ Se eliminaron ${total} productos.`);
}

async function sendChart(bot, chatId, url) {
  const product = getProduct(url);
  if (!product) return bot.sendMessage(chatId, "⚠️ Producto no encontrado en seguimiento. Usa /list");
  if (!Array.isArray(product.history) || product.history.length < 2) {
    return bot.sendMessage(chatId, "📉 No hay suficiente historial para graficar (se requieren al menos 2 registros).");
  }
  const sorted = product.history
    .map(h => ({ date: new Date(h.date), price: h.price }))
    .sort((a, b) => a.date - b.date);
  const labels = sorted.map(s =>
    s.date.toLocaleString("es-MX", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }));
  const prices = sorted.map(s => s.price);
  try {
    const buf = await generateChartBuffer(labels, prices, product.title);
    await bot.sendPhoto(chatId, buf, {
      caption: `📊 *Histórico de precios*\n${escapeMD(product.title)}`,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "🛒 Ver en Amazon", url }]] },
    });
  } catch (err) {
    await bot.sendMessage(chatId, "❌ Ocurrió un error generando el gráfico.");
  }
}

export async function sendDailySummary(bot) {
  for (const chatId of listChats()) {
    try {
      await sendList(bot, chatId);
      await new Promise(r => setTimeout(r, 400));
    } catch (err) {
      log.error("daily summary failed", { chatId, error: err.message });
    }
  }
}
