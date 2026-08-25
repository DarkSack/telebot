import { chromium } from "playwright";
import { config } from "./config.mjs";
import { log } from "./logger.mjs";
import { sleep } from "./utils.mjs";

// ══════════════════════════════════════════════════════════════
// Scraper de Amazon con Playwright.
//
// Diseño:
//  - Un solo browser + context reutilizado por todas las funciones
//    (evita el overhead de 2-3s por launch).
//  - `withPage(fn)` abre página, cierra al finalizar (incluso en throw).
//  - Selectores multi-fallback para resistir cambios menores del DOM.
// ══════════════════════════════════════════════════════════════

let _browser = null;
let _context = null;

async function ensureBrowser() {
  if (_browser && _context) return { browser: _browser, context: _context };
  _browser = await chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage"],   // sin --no-sandbox: no somos root
  });
  _context = await _browser.newContext({
    userAgent: config.userAgent,
    viewport: { width: 1366, height: 768 },
    locale: "es-MX",
  });
  log.info("browser launched");
  return { browser: _browser, context: _context };
}

export async function closeBrowser() {
  if (_context) { await _context.close().catch(() => {}); _context = null; }
  if (_browser) { await _browser.close().catch(() => {}); _browser = null; }
  log.info("browser closed");
}

async function withPage(fn) {
  const { context } = await ensureBrowser();
  const page = await context.newPage();
  try { return await fn(page); }
  finally { await page.close().catch(() => {}); }
}

/**
 * Scrapea título, precio e imagen. En caso de fallo devuelve
 * `{ error: string }` en vez de throw — el caller decide cómo tratarlo.
 */
export async function scrapeProduct(url) {
  return withPage(async (page) => {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.playwrightTimeoutMs });
      await sleep(800);   // deja que carguen bits lazy

      const title = await page.evaluate(() => {
        const sels = [
          "#productTitle",
          "h1#title",
          "h1.a-size-large",
          'h1[data-automation-id="product-title"]',
        ];
        for (const s of sels) {
          const el = document.querySelector(s);
          if (el?.textContent?.trim()) return el.textContent.trim();
        }
        return null;
      });

      const priceText = await page.evaluate(() => {
        const sels = [
          "span.a-price .a-offscreen",
          "span#priceblock_ourprice",
          "span#priceblock_dealprice",
          "div#corePrice_feature_div span.a-offscreen",
          'span[data-a-color="price"]',
          "span.a-offscreen",
        ];
        for (const s of sels) {
          const el = document.querySelector(s);
          if (el?.textContent?.trim()) return el.textContent.trim();
        }
        return null;
      });

      const imageUrl = await page.evaluate(() => {
        const sels = ["#landingImage", "div#imgTagWrapperId img", "img[data-old-hires]", ".a-dynamic-image"];
        for (const s of sels) {
          const el = document.querySelector(s);
          if (el?.src) return el.src;
        }
        return null;
      });

      if (!title) return { error: "Título no encontrado (¿página bloqueada por captcha?)" };
      if (!priceText) return { error: "Precio no encontrado" };
      const price = Number.parseFloat(priceText.replace(/[^0-9.,]/g, "").replace(",", "."));
      if (Number.isNaN(price) || price <= 0) return { error: `Precio inválido: '${priceText}'` };

      return { title, price, imageUrl };
    } catch (err) {
      return { error: err.message || String(err) };
    }
  });
}
