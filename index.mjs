// bot.js
import fs from "fs";
import TelegramBot from "node-telegram-bot-api";
import cron from "node-cron";
import dotenv from "dotenv";
import { chromium } from "playwright";

dotenv.config();

// ----------------- Config -----------------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
if (!TELEGRAM_TOKEN) {
  console.error("❌ TELEGRAM_TOKEN no definido en .env");
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ----------------- Persistence -----------------
const DATA_FILE = "prices.json";
let priceData = {}; // keys: sanitizedUrl -> product object
let chats = new Set();

function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      priceData = saved.products || {};
      chats = new Set(saved.chats || []);
      console.log(`✅ Datos cargados. Productos: ${Object.keys(priceData).length}, Chats: ${chats.size}`);
    } catch (err) {
      console.error("❌ Error al cargar datos:", err.message);
      priceData = {};
      chats = new Set();
    }
  } else {
    console.log("ℹ️ No existe prices.json — se creará al guardar.");
  }
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ products: priceData, chats: [...chats] }, null, 2));
    // console.log("✅ Datos guardados.");
  } catch (err) {
    console.error("❌ Error guardando datos:", err.message);
  }
}

loadData();

// ----------------- Utils -----------------
function sanitizeAmazonURL(url) {
  try {
    const u = new URL(url);
    // Keep pathname and /dp/... or /gp/... if present; strip query & hash
    return u.origin + u.pathname;
  } catch {
    return url.split("?")[0];
  }
}

// Escape for Markdown (basic). This function escapes characters that break Markdown.
function escapeMD(text = "") {
  return String(text).replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

// Limit history size (keeps last N entries)
const HISTORY_LIMIT = 120;

// ----------------- Scraper -----------------
// This scraper uses a single page instance per cycle; selectors include common Amazon patterns.
async function scrapeProduct(page, url) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Wait for elements likely to appear (don't always rely on arbitrary timeout)
    await page.waitForTimeout(800); // short sleep to allow lazy-loaded bits; not blocking too long

    const title = await page.evaluate(() => {
      const selectors = [
        "#productTitle",
        "h1#title",
        "h1.a-size-large",
        'h1[data-automation-id="product-title"]',
        ".product-title"
      ];
      for (const s of selectors) {
        const el = document.querySelector(s);
        if (el?.textContent?.trim()) return el.textContent.trim();
      }
      return null;
    });

    const priceText = await page.evaluate(() => {
      const selectors = [
        "span.a-price .a-offscreen",
        "span.a-offscreen",
        "span#priceblock_ourprice",
        "span#priceblock_dealprice",
        "div#corePrice_feature_div span.a-offscreen",
        'span[data-a-color="price"]'
      ];
      for (const s of selectors) {
        const el = document.querySelector(s);
        if (el?.textContent?.trim()) return el.textContent.trim();
      }
      return null;
    });

    const imageUrl = await page.evaluate(() => {
      const selectors = [
        "#landingImage",
        "div#imgTagWrapperId img",
        "img[data-old-hires]",
        ".a-dynamic-image"
      ];
      for (const s of selectors) {
        const el = document.querySelector(s);
        if (el?.src) return el.src;
      }
      // fallback: first image
      const firstImg = document.querySelector("img");
      return firstImg?.src || null;
    });

    if (!title) throw new Error("Título no encontrado");
    const price = priceText ? parseFloat(priceText.replace(/[^0-9.]/g, "")) : null;
    if (price === null || isNaN(price) || price <= 0) throw new Error("Precio inválido o no encontrado");

    return { url, title, price, imageUrl };
  } catch (err) {
    // Return object with error to let caller decide
    return { error: err.message || String(err) };
  }
}

// ----------------- Price-check logic -----------------
async function checkPrices() {
  const keys = Object.keys(priceData);
  if (!keys.length) {
    console.log("ℹ️ No hay productos para revisar.");
    return;
  }

  console.log("⏳ Iniciando revisión de precios...");

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const context = await browser.newContext();
  const page = await context.newPage();

  const productsChanged = [];
  const errors = [];

  // Iterate over snapshot of keys so we can safely modify priceData inside loop
  for (const key of keys) {
    const stored = priceData[key];
    if (!stored) continue;

    // Use product.url if stored, else fallback to key
    const sourceUrl = stored.url || key;
    const sanitized = sanitizeAmazonURL(sourceUrl);

    const scraped = await scrapeProduct(page, sanitized);
    if (scraped.error) {
      errors.push(`Error en ${stored.title || key}: ${scraped.error}`);
      // Even on error, update lastChecked
      stored.lastChecked = new Date().toISOString();
      priceData[key] = stored;
      await new Promise((r) => setTimeout(r, 800));
      continue;
    }

    // Ensure we store under sanitized key
    const finalKey = sanitized;

    // prepare original values (may be undefined)
    const originalPrice = typeof stored.price === "number" ? stored.price : scraped.price;
    const originalLowest = typeof stored.lowestPrice === "number" ? stored.lowestPrice : scraped.price;

    // Build updated object
    const updated = {
      url: sanitized,
      title: scraped.title,
      price: scraped.price,
      imageUrl: scraped.imageUrl || stored.imageUrl || null,
      lastChecked: new Date().toISOString(),
      addedDate: stored.addedDate || new Date().toISOString(),
      addedBy: stored.addedBy || null,
      lowestPrice: Math.min(scraped.price, originalLowest),
      history: Array.isArray(stored.history) ? stored.history.slice() : []
    };

    // Always append history (you requested to save even if not changed)
    updated.history.push({ date: new Date().toISOString(), price: scraped.price });
    if (updated.history.length > HISTORY_LIMIT) updated.history = updated.history.slice(-HISTORY_LIMIT);

    // Detect price drop compared to stored.price (originalPrice)
    if (scraped.price < originalPrice) {
      const diff = (originalPrice - scraped.price).toFixed(2);
      const pct = (((originalPrice - scraped.price) / originalPrice) * 100).toFixed(1);

      const msg =
`🚨 ¡Precio reducido!\n\n*${escapeMD(updated.title)}*\n\n💰 Precio anterior: $${originalPrice}\n🎯 Precio actual: $${scraped.price}\n💵 Ahorro: $${diff} (${pct}% menos)\n📉 Histórico más bajo: $${updated.lowestPrice}\n\n[Ver en Amazon](${sanitized})`;

      productsChanged.push({ url: sanitized, message: msg, imageUrl: updated.imageUrl });
    }

    // Save updated under sanitized key. If key changed (due to sanitization), delete old.
    priceData[finalKey] = updated;
    if (finalKey !== key) delete priceData[key];

    // small pause to avoid flooding
    await new Promise((r) => setTimeout(r, 900));
  }

  await browser.close();
  saveData();

  // Notify chats about changes
  if (productsChanged.length) {
    console.log(`🎉 ${productsChanged.length} productos cambiados — notificando a ${chats.size} chats.`);
    for (const chatId of chats) {
      for (const p of productsChanged) {
        try {
          if (p.imageUrl) {
            await bot.sendPhoto(chatId, p.imageUrl, {
              caption: p.message,
              parse_mode: "Markdown",
              reply_markup: { inline_keyboard: [[{ text: "🛒 Ver en Amazon", url: p.url }]] }
            });
          } else {
            await bot.sendMessage(chatId, p.message, {
              parse_mode: "Markdown",
              reply_markup: { inline_keyboard: [[{ text: "🛒 Ver en Amazon", url: p.url }]] }
            });
          }
        } catch (err) {
          console.error(`❌ Error enviando notificación a ${chatId}:`, err.message);
        }
        // small pause between messages
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  } else {
    console.log("ℹ️ No se detectaron bajadas de precio en esta pasada.");
  }

  if (errors.length) console.warn("⚠️ Errores durante la revisión:", errors);
}

// ----------------- Chart generation (from bot's history) -----------------
async function generateChartBuffer(labels, prices, title) {
  // Use Playwright to render a Chart.js chart and screenshot the canvas
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const html = `
  <html>
    <head>
      <meta charset="utf-8" />
      <style>body{margin:0;padding:0}</style>
    </head>
    <body>
      <canvas id="chart" width="900" height="420"></canvas>
      <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
      <script>
        const labels = ${JSON.stringify(labels)};
        const data = ${JSON.stringify(prices)};
        const title = ${JSON.stringify(title || "")};
        const ctx = document.getElementById('chart').getContext('2d');
        new Chart(ctx, {
          type: 'line',
          data: {
            labels,
            datasets: [{
              label: 'Precio',
              data,
              borderWidth: 2,
              tension: 0.2,
              fill: false
            }]
          },
          options: {
            responsive: false,
            plugins: {
              title: { display: true, text: title }
            },
            scales: {
              y: { beginAtZero: false }
            }
          }
        });
      </script>
    </body>
  </html>
  `;

  await page.setContent(html, { waitUntil: "load" });
  // Wait a bit for Chart.js to render
  await page.waitForTimeout(1000);
  const canvas = await page.$("#chart");
  const buffer = await canvas.screenshot();
  await browser.close();
  return buffer;
}

async function sendPriceChart(chatId, productUrl) {
  const product = priceData[productUrl];
  if (!product) return bot.sendMessage(chatId, "⚠️ Producto no encontrado en seguimiento. Usa /list");

  if (!Array.isArray(product.history) || product.history.length < 2) {
    return bot.sendMessage(chatId, "📉 No hay suficiente historial para graficar (se requieren al menos 2 registros).");
  }

  const sorted = product.history.map(h => ({ date: new Date(h.date), price: h.price })).sort((a, b) => a.date - b.date);

  const labels = sorted.map(s => s.date.toLocaleString("es-MX", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }));
  const prices = sorted.map(s => s.price);

  try {
    const buf = await generateChartBuffer(labels, prices, product.title);
    await bot.sendPhoto(chatId, buf, {
      caption: `📊 *Histórico de precios*\n${escapeMD(product.title)}`,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "🛒 Ver en Amazon", url: productUrl }]] }
    });
  } catch (err) {
    console.error("❌ Error generando gráfico:", err.message);
    await bot.sendMessage(chatId, "❌ Ocurrió un error generando el gráfico.");
  }
}

// ----------------- Telegram UI / Commands -----------------
async function dailySummary(chatId) {
  const urls = Object.keys(priceData);
  if (!urls.length) {
    return bot.sendMessage(chatId, "📭 No tienes productos en seguimiento.\n\nUsa /add [url] para agregar uno.");
  }

  const inlineKeyboard = urls.map((u) => {
    const p = priceData[u];
    const title = p?.title || u;
    const truncated = title.length > 30 ? `${title.slice(0, 30)}...` : title;
    return [{ text: `📦 ${truncated}`, callback_data: `select_product:${u}` }];
  });

  inlineKeyboard.push([{ text: "🗑️ Eliminar todos", callback_data: "delete_all" }]);
  inlineKeyboard.push([{ text: "🔄 Revisar precios ahora", callback_data: "check_prices" }]);

  await bot.sendMessage(chatId, `📊 *Productos en seguimiento: ${urls.length}*\n\nSelecciona un producto para ver detalles:`, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: inlineKeyboard }
  });
}

// /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  if (!chats.has(chatId)) {
    chats.add(chatId);
    saveData();
    console.log(`🎉 Nuevo chat registrado: ${chatId}`);
  }

  const welcome =
`🤖 ¡Hola! Soy tu bot rastreador de precios.

*Comandos:*
📦 /add [url] - Añadir producto
🔍 /check - Revisar precios ahora
📝 /list - Ver productos en seguimiento
🗑️ /remove [url] - Eliminar producto
✏️ /edit [url_actual] [url_nueva] - Actualizar URL del producto
📊 /stats - Ver estadísticas
📈 /chart [url] - Ver gráfico del historial
❓ /help - Mostrar ayuda`;

  bot.sendMessage(chatId, welcome, { parse_mode: "Markdown" });
});

// /help
bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
`📖 *Guía rápida*

/add https://... - Agrega producto
/check - Forzar revisión
/list - Ver productos
/remove [url] - Eliminar
/edit [url_actual] [url_nueva] - Actualizar URL
/stats - Estadísticas
/chart [url] - Gráfico del historial`, { parse_mode: "Markdown" });
});

// /add
bot.onText(/\/add (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const raw = match[1].trim();
  if (!raw.startsWith("http")) return bot.sendMessage(chatId, "❌ URL inválida. Debe iniciar con http(s).");

  const sanitized = sanitizeAmazonURL(raw);
  if (priceData[sanitized]) {
    return bot.sendMessage(chatId, `⚠️ Este producto ya está en seguimiento:\n*${escapeMD(priceData[sanitized].title || sanitized)}*`, { parse_mode: "Markdown" });
  }

  const loading = await bot.sendMessage(chatId, "⏳ Obteniendo información del producto...");

  // Launch temporary browser to fetch initial data
  try {
    const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const context = await browser.newContext();
    const page = await context.newPage();

    const scraped = await scrapeProduct(page, sanitized);
    await browser.close();

    if (scraped.error || !scraped.title || !scraped.price) {
      await bot.editMessageText("❌ No se pudo obtener información del producto. Revisa la URL o prueba otra.", {
        chat_id: chatId,
        message_id: loading.message_id
      });
      return;
    }

    priceData[sanitized] = {
      url: sanitized,
      title: scraped.title,
      price: scraped.price,
      lowestPrice: scraped.price,
      imageUrl: scraped.imageUrl || null,
      addedDate: new Date().toISOString(),
      addedBy: chatId,
      lastChecked: new Date().toISOString(),
      history: [{ date: new Date().toISOString(), price: scraped.price }]
    };

    saveData();

    const success =
`✅ *Producto agregado exitosamente*

📦 ${escapeMD(scraped.title)}
💰 Precio actual: $${scraped.price}
📅 Agregado: ${new Date().toLocaleDateString()}

🔔 Te notificaré cuando baje el precio.`;

    await bot.editMessageText(success, {
      chat_id: chatId,
      message_id: loading.message_id,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🛒 Ver en Amazon", url: sanitized }, { text: "📝 Ver todos", callback_data: "list" }]
        ]
      }
    });
  } catch (err) {
    console.error("❌ Error en /add:", err.message);
    await bot.editMessageText("❌ Ocurrió un error agregando el producto. Intenta de nuevo más tarde.", {
      chat_id: chatId,
      message_id: loading.message_id
    });
  }
});

// /check
bot.onText(/\/check/, async (msg) => {
  const chatId = msg.chat.id;
  const loading = await bot.sendMessage(chatId, "⏳ Revisando precios de todos los productos... (esto puede tardar)");
  try {
    await checkPrices();
    await bot.editMessageText("✅ Revisión completada. Si hubo cambios, los notifiqué.", {
      chat_id: chatId,
      message_id: loading.message_id
    });
  } catch (err) {
    console.error("❌ Error en /check:", err.message);
    await bot.editMessageText("❌ Ocurrió un error durante la revisión.", {
      chat_id: chatId,
      message_id: loading.message_id
    });
  }
});

// /list
bot.onText(/\/list/, async (msg) => dailySummary(msg.chat.id));

// /stats
bot.onText(/\/stats/, (msg) => {
  const chatId = msg.chat.id;
  const totalProducts = Object.keys(priceData).length;
  const totalChats = chats.size;

  if (totalProducts === 0) {
    return bot.sendMessage(chatId, "📊 No tienes productos en seguimiento aún.\nUsa /add [url] para empezar.");
  }

  let totalSavings = 0;
  let productsWithSavings = 0;

  Object.values(priceData).forEach((product) => {
    if (typeof product.lowestPrice === "number" && typeof product.price === "number") {
      if (product.price < product.lowestPrice) {
        totalSavings += (product.lowestPrice - product.price);
        productsWithSavings++;
      }
    }
  });

  const statsMsg =
`📊 *Estadísticas de seguimiento*\n\n📦 Productos: ${totalProducts}\n👥 Chats registrados: ${totalChats}\n💰 Ahorro potencial detectado: $${totalSavings.toFixed(2)}\n📉 Productos con precio reducido: ${productsWithSavings}`;

  bot.sendMessage(chatId, statsMsg, { parse_mode: "Markdown" });
});

// /remove
bot.onText(/\/remove (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const raw = match[1].trim();
  const sanitized = sanitizeAmazonURL(raw);

  if (priceData[sanitized]) {
    const title = priceData[sanitized].title || sanitized;
    delete priceData[sanitized];
    saveData();
    return bot.sendMessage(chatId, `🗑️ *Producto eliminado:*\n${escapeMD(title)}`, { parse_mode: "Markdown" });
  }

  // Sometimes user passes a key that is not sanitized; try find by partial match
  const foundKey = Object.keys(priceData).find(k => k.includes(raw) || (priceData[k].title && priceData[k].title.includes(raw)));
  if (foundKey) {
    const title = priceData[foundKey].title || foundKey;
    delete priceData[foundKey];
    saveData();
    return bot.sendMessage(chatId, `🗑️ *Producto eliminado:*\n${escapeMD(title)}`, { parse_mode: "Markdown" });
  }

  bot.sendMessage(chatId, "⚠️ No se encontró producto con esa URL.\nUsa /list para ver tus productos.", { parse_mode: "Markdown" });
});

// /edit oldUrl newUrl
bot.onText(/\/edit (.+?) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const oldRaw = match[1].trim();
  const newRaw = match[2].trim();

  const oldKey = sanitizeAmazonURL(oldRaw);
  const newKey = sanitizeAmazonURL(newRaw);

  if (!priceData[oldKey]) {
    return bot.sendMessage(chatId, "⚠️ No se encontró producto con la URL original. Usa /list", { parse_mode: "Markdown" });
  }

  const loading = await bot.sendMessage(chatId, "⏳ Actualizando producto...");

  try {
    // Scrape new url
    const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    const scraped = await scrapeProduct(page, newKey);
    await browser.close();

    if (scraped.error) {
      return bot.editMessageText("❌ No se pudo obtener información de la nueva URL. Asegúrate de que es válida.", {
        chat_id: chatId,
        message_id: loading.message_id
      });
    }

    const prev = priceData[oldKey];
    const lowest = typeof prev.lowestPrice === "number" ? prev.lowestPrice : prev.price || scraped.price;

    priceData[newKey] = {
      url: newKey,
      title: scraped.title,
      price: scraped.price,
      lowestPrice: Math.min(scraped.price, lowest),
      imageUrl: scraped.imageUrl || prev.imageUrl || null,
      addedDate: prev.addedDate || new Date().toISOString(),
      addedBy: prev.addedBy || chatId,
      lastChecked: new Date().toISOString(),
      history: Array.isArray(prev.history) ? prev.history.slice() : []
    };

    // add initial history point for the new url
    priceData[newKey].history.push({ date: new Date().toISOString(), price: scraped.price });
    if (priceData[newKey].history.length > HISTORY_LIMIT) priceData[newKey].history = priceData[newKey].history.slice(-HISTORY_LIMIT);

    // remove old key
    delete priceData[oldKey];
    saveData();

    await bot.editMessageText(`✅ *Producto actualizado*\n\nAntes: ${escapeMD(prev.title || oldKey)}\nAhora: ${escapeMD(scraped.title)}`, {
      chat_id: chatId,
      message_id: loading.message_id,
      parse_mode: "Markdown"
    });
  } catch (err) {
    console.error("❌ Error en /edit:", err.message);
    await bot.editMessageText("❌ Ocurrió un error al editar el producto. Intenta de nuevo.", {
      chat_id: chatId,
      message_id: loading.message_id
    });
  }
});

// /chart
bot.onText(/\/chart (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const raw = match[1].trim();
  const key = sanitizeAmazonURL(raw);

  if (!priceData[key]) {
    return bot.sendMessage(chatId, "⚠️ No encontré ese producto en seguimiento. Usa /list", { parse_mode: "Markdown" });
  }

  await sendPriceChart(chatId, key);
});

// ----------------- Callback query (inline buttons) -----------------
bot.on("callback_query", async (callbackQuery) => {
  const data = callbackQuery.data;
  const msg = callbackQuery.message;
  const chatId = msg.chat.id;
  await bot.answerCallbackQuery(callbackQuery.id).catch(() => {});

  try {
    if (data.startsWith("select_product:")) {
      const productUrl = data.substring("select_product:".length);
      const product = priceData[productUrl];
      if (!product) return bot.sendMessage(chatId, "❌ Producto no encontrado.");

      const addedDate = product.addedDate ? new Date(product.addedDate).toLocaleDateString() : "N/A";
      const lastChecked = product.lastChecked ? new Date(product.lastChecked).toLocaleDateString() : "Nunca";
      const priceDifference = (product.lowestPrice || product.price) - product.price;
      const savingsText = priceDifference > 0 ? `\n💰 Ahorro desde el mínimo: $${priceDifference.toFixed(2)}` : "";

      const messageText =
`*${escapeMD(product.title)}*\n\n💰 Precio actual: $${product.price}\n📉 Precio más bajo visto: $${product.lowestPrice}\n📅 Agregado: ${addedDate}\n🔄 Última revisión: ${lastChecked}${savingsText}`;

      const keyboard = {
        inline_keyboard: [
          [{ text: "🛒 Ver en Amazon", url: product.url }],
          [
            { text: "✍🏻 Editar URL", callback_data: `edit_product:${productUrl}` },
            { text: "🗑️ Eliminar", callback_data: `delete_product:${productUrl}` }
          ],
          [{ text: "⏪ Volver a la lista", callback_data: "list" }],
          [{ text: "📈 Ver gráfico", callback_data: `chart:${productUrl}` }]
        ]
      };

      if (product.imageUrl) {
        await bot.sendPhoto(chatId, product.imageUrl, { caption: messageText, parse_mode: "Markdown", reply_markup: keyboard });
      } else {
        await bot.sendMessage(chatId, messageText, { parse_mode: "Markdown", reply_markup: keyboard });
      }
    } else if (data.startsWith("delete_product:")) {
      const urlToDelete = data.substring("delete_product:".length);
      if (priceData[urlToDelete]) {
        const title = priceData[urlToDelete].title || urlToDelete;
        delete priceData[urlToDelete];
        saveData();
        await bot.sendMessage(chatId, `🗑️ *Producto eliminado:*\n${escapeMD(title)}`, { parse_mode: "Markdown" });
      } else {
        await bot.sendMessage(chatId, "❌ Producto no encontrado.");
      }
      await dailySummary(chatId);
    } else if (data.startsWith("edit_product:")) {
      const urlToEdit = data.substring("edit_product:".length);
      await bot.sendMessage(chatId, `✍🏻 Para editar la URL usa:\n\`/edit ${urlToEdit} [nueva_url]\``, { parse_mode: "Markdown" });
    } else if (data === "delete_all") {
      const totalProducts = Object.keys(priceData).length;
      priceData = {};
      saveData();
      await bot.sendMessage(chatId, `🗑️ Se eliminaron ${totalProducts} productos.`);
    } else if (data === "list") {
      await dailySummary(chatId);
    } else if (data === "check_prices") {
      const loading = await bot.sendMessage(chatId, "⏳ Iniciando revisión de precios...");
      try {
        await checkPrices();
        await bot.editMessageText("✅ Revisión completada.", { chat_id: chatId, message_id: loading.message_id });
      } catch (err) {
        await bot.editMessageText("❌ Error durante la revisión.", { chat_id: chatId, message_id: loading.message_id });
      }
    } else if (data.startsWith("chart:")) {
      const url = data.substring("chart:".length);
      await sendPriceChart(chatId, url);
    } else {
      await bot.sendMessage(chatId, "Comando inline no reconocido.");
    }
  } catch (err) {
    console.error("❌ Error manejando callback:", err.message);
    await bot.sendMessage(chatId, "❌ Ocurrió un error procesando la acción.");
  }
});

// ----------------- Auto-register chats on any message (only once) -----------------
bot.on("message", (msg) => {
  const chatId = msg.chat.id;
  if (!chats.has(chatId)) {
    chats.add(chatId);
    saveData();
    console.log(`🎉 Nuevo chat registrado (por mensaje): ${chatId}`);
  }
});

// ----------------- Polling / error handlers -----------------
bot.on("polling_error", (err) => console.error("❌ Polling error:", err?.message || err));
bot.on("error", (err) => console.error("❌ Bot error:", err?.message || err));

// ----------------- Cronjobs -----------------
// Daily summary at 20:00 (server timezone)
cron.schedule("0 20 * * *", async () => {
  console.log("📄 Envío de resumen diario...");
  for (const chatId of chats) {
    try {
      await dailySummary(chatId);
      await new Promise(r => setTimeout(r, 400));
    } catch (err) {
      console.error(`❌ Error enviando resumen a ${chatId}:`, err.message);
    }
  }
});

// Check prices every 2 hours
cron.schedule("0 */2 * * *", async () => {
  console.log("🔄 Cron: revisión automática de precios...");
  try {
    await checkPrices();
  } catch (err) {
    console.error("❌ Error en cron checkPrices:", err.message);
  }
});

// ----------------- Graceful shutdown -----------------
process.on("SIGINT", async () => {
  console.log("🛑 Cerrando bot...");
  try {
    bot.stopPolling();
  } catch {}
  // No global browser to close; each function closes its browsers
  process.exit(0);
});

console.log("🚀 Bot iniciado. Esperando comandos...");
