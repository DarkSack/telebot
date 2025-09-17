import fs from "fs";
import TelegramBot from "node-telegram-bot-api";
import cron from "node-cron";
import dotenv from "dotenv";
import { chromium } from "playwright";

// --- Configuración inicial ---
dotenv.config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
if (!TELEGRAM_TOKEN) {
  console.error(
    "❌ Error: TELEGRAM_TOKEN no está definido en el archivo .env."
  );
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// --- Gestión de datos ---
const DATA_FILE = "prices.json";

let priceData = {};
let chats = new Set();

function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      priceData = saved.products || {};
      chats = new Set(saved.chats || []);
      console.log(
        `✅ Datos cargados de ${DATA_FILE}. Productos: ${
          Object.keys(priceData).length
        }, Chats: ${chats.size}`
      );
    } catch (err) {
      console.error(`❌ Error al cargar ${DATA_FILE}:`, err.message);
    }
  } else {
    console.log(`ℹ️ Archivo ${DATA_FILE} no encontrado. Creando uno nuevo.`);
  }
}

function saveData() {
  try {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify({ products: priceData, chats: Array.from(chats) }, null, 2)
    );
    console.log(`✅ Datos guardados en ${DATA_FILE}`);
  } catch (err) {
    console.error(`❌ Error al guardar datos:`, err.message);
  }
}

loadData();

// --- Scraper con Playwright ---
async function scrapeProduct(url) {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Esperar un poco más para que cargue el contenido
    await page.waitForTimeout(2000);

    // Intentar múltiples selectores para el título
    const title = await page.evaluate(() => {
      const selectors = [
        "span#productTitle",
        "h1.a-size-large",
        'h1[data-automation-id="product-title"]',
        ".product-title",
      ];

      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element && element.textContent.trim()) {
          return element.textContent.trim();
        }
      }
      return null;
    });

    // Intentar múltiples selectores para el precio
    const priceText = await page.evaluate(() => {
      const selectors = [
        "span.a-price-whole",
        "span.a-offscreen",
        ".a-price .a-offscreen",
        "div#corePrice_feature_div span.a-offscreen",
        'span[data-a-color="price"]',
        ".a-price-range .a-offscreen",
      ];

      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element && element.textContent.trim()) {
          return element.textContent.trim();
        }
      }
      return null;
    });

    // Intentar múltiples selectores para la imagen
    const imageUrl = await page.evaluate(() => {
      const selectors = [
        "div#imgTagWrapperId img",
        "img#landingImage",
        "img[data-old-hires]",
        ".a-dynamic-image",
      ];

      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element && element.src) {
          return element.src;
        }
      }
      return null;
    });

    if (!title) {
      throw new Error("No se pudo obtener el título del producto.");
    }

    const price = priceText
      ? parseFloat(priceText.replace(/[$,€\s]/g, "").replace(/[^\d.]/g, ""))
      : null;

    if (!price || isNaN(price) || price <= 0) {
      throw new Error("No se pudo obtener el precio o no es un número válido.");
    }

    return { url, title, price, imageUrl };
  } catch (err) {
    console.error(`❌ Error al obtener datos de ${url}:`, err.message);
    return {
      url,
      title: null,
      price: null,
      imageUrl: null,
      error: err.message,
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}


// --- Lógica principal ---
async function checkPrices() {
  console.log("⏳ Iniciando revisión de precios...");
  const urlsToCheck = Object.keys(priceData);
  if (urlsToCheck.length === 0) {
    console.log("ℹ️ No hay productos para revisar.");
    return;
  }

  const productsChanged = [];
  const errors = [];

  for (const url of urlsToCheck) {
    try {
      const originalProduct = priceData[url];
      const scrapedProduct = await scrapeProduct(url);

      if (scrapedProduct.error) {
        errors.push(
          `Error en ${originalProduct.title}: ${scrapedProduct.error}`
        );
        continue;
      }

      if (
        scrapedProduct.price &&
        scrapedProduct.price < originalProduct.price
      ) {
        const priceDiff = (
          originalProduct.price - scrapedProduct.price
        ).toFixed(2);
        const percentageOff = (
          ((originalProduct.price - scrapedProduct.price) /
            originalProduct.price) *
          100
        ).toFixed(1);

        const msg = `🚨 ¡Precio reducido!\n\n*${
          originalProduct.title
        }*\n\n💰 Precio anterior: $${
          originalProduct.price
        }\n🎯 Precio actual: $${
          scrapedProduct.price
        }\n💵 Ahorro: $${priceDiff} (${percentageOff}% menos)\n📉 Histórico más bajo: $${Math.min(
          scrapedProduct.price,
          originalProduct.lowestPrice
        )}\n\n[Ver en Amazon](${url})`;

        productsChanged.push({
          url,
          message: msg,
          imageUrl: scrapedProduct.imageUrl,
        });
      }

      if (scrapedProduct.price) {
        priceData[url] = {
          ...originalProduct,
          price: scrapedProduct.price,
          lowestPrice: Math.min(
            scrapedProduct.price,
            originalProduct.lowestPrice
          ),
          imageUrl: scrapedProduct.imageUrl || originalProduct.imageUrl,
          lastChecked: new Date().toISOString(),
        };
      }

      // Pequeña pausa entre requests para evitar rate limiting
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (err) {
      console.error(`❌ Error procesando ${url}:`, err.message);
      errors.push(`Error procesando producto: ${err.message}`);
    }
  }

  saveData();

  if (productsChanged.length > 0) {
    console.log(
      `🎉 ¡Se encontraron ${productsChanged.length} productos con cambios!`
    );
    for (const chat of chats) {
      for (const product of productsChanged) {
        try {
          if (product.imageUrl) {
            await bot.sendPhoto(chat, product.imageUrl, {
              caption: product.message,
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "🛒 Ver en Amazon", url: product.url }],
                ],
              },
            });
          } else {
            await bot.sendMessage(chat, product.message, {
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "🛒 Ver en Amazon", url: product.url }],
                ],
              },
            });
          }
          // Pausa entre mensajes
          await new Promise((resolve) => setTimeout(resolve, 500));
        } catch (err) {
          console.error(
            `❌ Error enviando mensaje a chat ${chat}:`,
            err.message
          );
        }
      }
    }
  } else {
    console.log("ℹ️ No se encontraron cambios de precio significativos.");
  }

  // Log de errores si los hay
  if (errors.length > 0) {
    console.log("⚠️ Errores durante la revisión:", errors);
  }
}

// --- Resumen visual para Telegram ---
async function dailySummary(chatId) {
  const urls = Object.keys(priceData);

  if (!urls.length) {
    await bot.sendMessage(
      chatId,
      "📭 No tienes productos en seguimiento.\n\nUsa `/add [url]` para agregar uno."
    );
    return;
  }

  const inlineKeyboard = urls.map((url) => {
    const product = priceData[url];
    const truncatedTitle =
      product.title?.length > 30
        ? `${product.title.slice(0, 30)}...`
        : product.title;
    return [
      { text: `📦 ${truncatedTitle}`, callback_data: `select_product:${url}` },
    ];
  });

  inlineKeyboard.push([
    { text: "🗑️ Eliminar todos", callback_data: "delete_all" },
  ]);
  inlineKeyboard.push([
    { text: "🔄 Revisar precios ahora", callback_data: "check_prices" },
  ]);

  await bot.sendMessage(
    chatId,
    `📊 *Productos en seguimiento: ${urls.length}*\n\nSelecciona un producto para ver detalles:`,
    {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: inlineKeyboard },
    }
  );
}

// --- Comandos de Telegram ---
bot.onText(/\/start/, (msg) => {
  const welcomeMessage =
    "🤖 ¡Hola! Soy tu bot rastreador de precios de Amazon.\n\n" +
    "*Comandos disponibles:*\n" +
    "📦 `/add [url]` - Añadir producto para rastrear\n" +
    "🔍 `/check` - Revisar precios manualmente\n" +
    "📝 `/list` - Ver productos en seguimiento\n" +
    "🗑️ `/remove [url]` - Eliminar producto\n" +
    "✏️ `/edit [url_actual] [url_nueva]` - Actualizar URL\n" +
    "📊 `/stats` - Ver estadísticas\n" +
    "❓ `/help` - Ver esta ayuda\n\n" +
    "🔔 Te notificaré automáticamente cuando bajen los precios.\n" +
    "⏰ Reviso precios cada 2 horas y envío resúmenes diarios.";

  bot.sendMessage(msg.chat.id, welcomeMessage, { parse_mode: "Markdown" });
});

bot.onText(/\/help/, (msg) => {
  const helpMessage =
    "📖 *Guía de uso:*\n\n" +
    "*Para agregar un producto:*\n" +
    "1. Ve a Amazon y copia la URL del producto\n" +
    "2. Envía: `/add https://amazon.com/...`\n\n" +
    "*Ejemplo de URL válida:*\n" +
    "`/add https://www.amazon.com/dp/B08N5WRWNW`\n\n" +
    "*Sitios soportados:*\n" +
    "🇺🇸 Amazon.com\n🇲🇽 Amazon.com.mx\n🇬🇧 Amazon.co.uk\n" +
    "🇩🇪 Amazon.de\n🇫🇷 Amazon.fr\n🇪🇸 Amazon.es\n" +
    "🇮🇹 Amazon.it\n🇨🇦 Amazon.ca\n🇧🇷 Amazon.com.br\n\n" +
    "💡 *Tip:* Usa `/list` para gestionar tus productos fácilmente.";

  bot.sendMessage(msg.chat.id, helpMessage, { parse_mode: "Markdown" });
});

bot.onText(/\/add (.+)/, async (msg, match) => {
  const url = match[1].trim();
  const chatId = msg.chat.id;

  // Validar que sea una URL
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return bot.sendMessage(
      chatId,
      "❌ Por favor, introduce una URL válida que comience con `http://` o `https://`.",
      { parse_mode: "Markdown" }
    );
  }

  // Verificar si ya existe
  if (priceData[url]) {
    return bot.sendMessage(
      chatId,
      `⚠️ Este producto ya está en seguimiento:\n*${priceData[url].title}*`,
      { parse_mode: "Markdown" }
    );
  }

  const loadingMsg = await bot.sendMessage(
    chatId,
    "⏳ Obteniendo información del producto..."
  );

  try {
    const product = await scrapeProduct(url);

    if (product.error || !product.title || !product.price) {
      await bot.editMessageText(
        `❌ No se pudo obtener información del producto.\n\n*Posibles causas:*\n• URL incorrecta o producto no disponible\n• Producto sin precio visible\n• Restricciones geográficas\n\nIntenta con otra URL.`,
        {
          chat_id: chatId,
          message_id: loadingMsg.message_id,
          parse_mode: "Markdown",
        }
      );
      return;
    }

    priceData[url] = {
      ...product,
      lowestPrice: product.price,
      addedDate: new Date().toISOString(),
      addedBy: chatId,
    };
    saveData();

    const successMsg =
      `✅ *Producto agregado exitosamente*\n\n` +
      `📦 ${product.title}\n` +
      `💰 Precio actual: $${product.price}\n` +
      `📅 Agregado: ${new Date().toLocaleDateString()}\n\n` +
      `🔔 Te notificaré cuando baje el precio.`;

    await bot.editMessageText(successMsg, {
      chat_id: chatId,
      message_id: loadingMsg.message_id,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🛒 Ver en Amazon", url: product.url },
            { text: "📝 Ver todos", callback_data: "list" },
          ],
        ],
      },
    });
  } catch (err) {
    console.error(
      `❌ Error al agregar producto para el chat ${chatId}:`,
      err.message
    );
    await bot.editMessageText(
      "❌ Ocurrió un error inesperado. Por favor, inténtalo de nuevo en unos minutos.",
      { chat_id: chatId, message_id: loadingMsg.message_id }
    );
  }
});

bot.onText(/\/check/, async (msg) => {
  const loadingMsg = await bot.sendMessage(
    msg.chat.id,
    "⏳ Revisando precios de todos los productos...\nEsto puede tardar varios minutos."
  );

  try {
    await checkPrices();
    await bot.editMessageText(
      "✅ Revisión completada. Si hubo cambios de precio, ya recibiste las notificaciones.",
      {
        chat_id: msg.chat.id,
        message_id: loadingMsg.message_id,
      }
    );
  } catch (err) {
    await bot.editMessageText(
      "❌ Ocurrió un error durante la revisión. Inténtalo más tarde.",
      {
        chat_id: msg.chat.id,
        message_id: loadingMsg.message_id,
      }
    );
  }
});

bot.onText(/\/list/, async (msg) => {
  await dailySummary(msg.chat.id);
});

bot.onText(/\/stats/, async (msg) => {
  const totalProducts = Object.keys(priceData).length;
  const totalChats = chats.size;

  if (totalProducts === 0) {
    return bot.sendMessage(
      msg.chat.id,
      "📊 No tienes productos en seguimiento aún.\n\nUsa `/add [url]` para comenzar."
    );
  }

  let totalSavings = 0;
  let productsWithSavings = 0;

  Object.values(priceData).forEach((product) => {
    if (product.price < product.lowestPrice) {
      totalSavings += product.lowestPrice - product.price;
      productsWithSavings++;
    }
  });

  const statsMsg =
    `📊 *Estadísticas de seguimiento*\n\n` +
    `📦 Productos: ${totalProducts}\n` +
    `👥 Chats registrados: ${totalChats}\n` +
    `💰 Ahorro potencial detectado: $${totalSavings.toFixed(2)}\n` +
    `📉 Productos con precio reducido: ${productsWithSavings}`;

  bot.sendMessage(msg.chat.id, statsMsg, { parse_mode: "Markdown" });
});

bot.onText(/\/remove (.+)/, (msg, match) => {
  const url = match[1].trim();
  if (priceData[url]) {
    const title = priceData[url].title;
    delete priceData[url];
    saveData();
    bot.sendMessage(msg.chat.id, `🗑️ *Producto eliminado:*\n${title}`, {
      parse_mode: "Markdown",
    });
  } else {
    bot.sendMessage(
      msg.chat.id,
      `⚠️ No se encontró producto con esa URL.\n\nUsa \`/list\` para ver tus productos.`,
      { parse_mode: "Markdown" }
    );
  }
});

bot.onText(/\/edit (.+?) (.+)/, async (msg, match) => {
  const [oldUrl, newUrl] = [match[1].trim(), match[2].trim()];
  const chatId = msg.chat.id;

  if (!priceData[oldUrl]) {
    return bot.sendMessage(
      chatId,
      `⚠️ No se encontró producto con la URL original.\n\nUsa \`/list\` para ver tus productos.`,
      { parse_mode: "Markdown" }
    );
  }

  const oldTitle = priceData[oldUrl].title;
  const loadingMsg = await bot.sendMessage(
    chatId,
    "⏳ Actualizando producto..."
  );

  try {
    const newProduct = await scrapeProduct(newUrl);
    if (newProduct.error || !newProduct.title || !newProduct.price) {
      return bot.editMessageText(
        "❌ No se pudo obtener información de la nueva URL. Asegúrate de que es válida.",
        {
          chat_id: chatId,
          message_id: loadingMsg.message_id,
        }
      );
    }

    const lowestPrice = priceData[oldUrl].lowestPrice;

    priceData[newUrl] = {
      ...newProduct,
      lowestPrice: Math.min(newProduct.price, lowestPrice),
      addedDate: priceData[oldUrl].addedDate,
      addedBy: priceData[oldUrl].addedBy,
    };

    delete priceData[oldUrl];
    saveData();

    await bot.editMessageText(
      `✅ *Producto actualizado*\n\nAntes: ${oldTitle}\nAhora: ${newProduct.title}`,
      {
        chat_id: chatId,
        message_id: loadingMsg.message_id,
        parse_mode: "Markdown",
      }
    );
  } catch (err) {
    console.error(
      `❌ Error al editar producto para el chat ${chatId}:`,
      err.message
    );
    await bot.editMessageText(
      "❌ Ocurrió un error al intentar editar el producto. Inténtalo de nuevo.",
      {
        chat_id: chatId,
        message_id: loadingMsg.message_id,
      }
    );
  }
});

// --- Manejador de botones inline ---
bot.on("callback_query", async (callbackQuery) => {
  const msg = callbackQuery.message;
  const data = callbackQuery.data;
  const chatId = msg.chat.id;

  await bot.answerCallbackQuery(callbackQuery.id);

  if (data.startsWith("select_product:")) {
    const productUrl = data.substring("select_product:".length);
    const product = priceData[productUrl];

    if (product) {
      const addedDate = product.addedDate
        ? new Date(product.addedDate).toLocaleDateString()
        : "N/A";
      const lastChecked = product.lastChecked
        ? new Date(product.lastChecked).toLocaleDateString()
        : "Nunca";
      const priceDifference = product.lowestPrice - product.price;
      const savingsText =
        priceDifference > 0
          ? `💰 Ahorro desde el mínimo: $${priceDifference.toFixed(2)}`
          : "";

      const messageText =
        `*${product.title}*\n\n` +
        `💰 Precio actual: $${product.price}\n` +
        `📉 Precio más bajo visto: $${product.lowestPrice}\n` +
        `📅 Agregado: ${addedDate}\n` +
        `🔄 Última revisión: ${lastChecked}\n` +
        savingsText;

      const keyboard = {
        inline_keyboard: [
          [{ text: "🛒 Ver en Amazon", url: product.url }],
          [
            {
              text: "✍🏻 Editar URL",
              callback_data: `edit_product:${productUrl}`,
            },
            {
              text: "🗑️ Eliminar",
              callback_data: `delete_product:${productUrl}`,
            },
          ],
          [{ text: "⏪ Volver a la lista", callback_data: "list" }],
        ],
      };

      try {
        if (product.imageUrl) {
          await bot.sendPhoto(chatId, product.imageUrl, {
            caption: messageText,
            parse_mode: "Markdown",
            reply_markup: keyboard,
          });
        } else {
          await bot.sendMessage(chatId, messageText, {
            parse_mode: "Markdown",
            reply_markup: keyboard,
          });
        }
      } catch (error) {
        await bot.sendMessage(chatId, messageText, {
          parse_mode: "Markdown",
          reply_markup: keyboard,
        });
      }
    } else {
      await bot.sendMessage(
        chatId,
        "❌ Producto no encontrado o ya eliminado."
      );
    }
  } else if (data.startsWith("delete_product:")) {
    const urlToDelete = data.substring("delete_product:".length);
    if (priceData[urlToDelete]) {
      const title = priceData[urlToDelete].title;
      delete priceData[urlToDelete];
      saveData();
      await bot.sendMessage(chatId, `🗑️ *Producto eliminado:*\n${title}`, {
        parse_mode: "Markdown",
      });
    } else {
      await bot.sendMessage(chatId, "❌ Producto no encontrado.");
    }
    await dailySummary(chatId);
  } else if (data.startsWith("edit_product:")) {
    const urlToEdit = data.substring("edit_product:".length);
    await bot.sendMessage(
      chatId,
      `✍🏻 Para editar la URL, usa:\n\`/edit ${urlToEdit} [nueva_url]\``,
      { parse_mode: "Markdown" }
    );
  } else if (data === "delete_all") {
    const totalProducts = Object.keys(priceData).length;
    priceData = {};
    saveData();
    await bot.sendMessage(
      chatId,
      `🗑️ Se eliminaron ${totalProducts} productos.`
    );
  } else if (data === "list") {
    await dailySummary(chatId);
  } else if (data === "check_prices") {
    const loadingMsg = await bot.sendMessage(
      chatId,
      "⏳ Iniciando revisión de precios..."
    );
    try {
      await checkPrices();
      await bot.editMessageText("✅ Revisión completada.", {
        chat_id: chatId,
        message_id: loadingMsg.message_id,
      });
    } catch (err) {
      await bot.editMessageText("❌ Error durante la revisión.", {
        chat_id: chatId,
        message_id: loadingMsg.message_id,
      });
    }
  }
});

// --- Funcionalidad de auto-registro del chat ---
bot.on("message", (msg) => {
  if (!chats.has(msg.chat.id)) {
    chats.add(msg.chat.id);
    saveData();
    console.log(`🎉 Nuevo chat registrado: ${msg.chat.id}`);
  }
});

// --- Manejo de errores del bot ---
bot.on("polling_error", (error) => {
  console.error("❌ Error de polling:", error.message);
});

bot.on("error", (error) => {
  console.error("❌ Error del bot:", error.message);
});

// --- Cronjobs para automatizar tareas ---
cron.schedule("0 20 * * *", () => {
  console.log("📄 Iniciando envío de resumen diario...");
  chats.forEach(async (chatId) => {
    try {
      await dailySummary(chatId);
    } catch (err) {
      console.error(`❌ Error enviando resumen a chat ${chatId}:`, err.message);
    }
  });
});

cron.schedule("0 */2 * * *", () => {
  console.log("🔄 Iniciando revisión automática de precios...");
  checkPrices();
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("🛑 Cerrando bot...");
  bot.stopPolling();
  process.exit(0);
});

console.log("🚀 Bot de Telegram iniciado. Esperando comandos...");
