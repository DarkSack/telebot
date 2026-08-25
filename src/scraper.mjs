import path from "node:path";
import { chromium as _chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import { config } from "./config.mjs";
import { log } from "./logger.mjs";
import { sleep } from "./utils.mjs";

// ══════════════════════════════════════════════════════════════
// Scraper de Amazon con anti-detección de bot.
//
// Layer 1: playwright-extra + stealth plugin — patcha las huellas
//   típicas del headless (navigator.webdriver, plugins array, canvas
//   fingerprint, WebGL vendor, notification API, chrome runtime, etc.)
//
// Layer 2: contexto persistente vía userDataDir — cookies + localStorage
//   sobreviven entre runs. Amazon marca las sesiones con historial como
//   más confiables. Una vez resuelto 1 captcha manual, dura semanas.
//
// Layer 3: retry con exponential backoff — a veces el captcha es transient
//   (Amazon lo sirve sólo en la primera request de la sesión).
// ══════════════════════════════════════════════════════════════

// Register stealth plugin (idempotente — safe si el módulo se re-importa).
_chromium.use(stealth());

let _context = null;
// Dominios ya "calentados" recientemente (host → timestamp del último warmup).
// Amazon empieza a servir captchas si haces N requests seguidos al mismo
// /dp/ pattern sin re-tocar la homepage. Re-calentamos cada N minutos.
const _warmedAt = new Map();
const WARMUP_TTL_MS = 10 * 60 * 1000;   // 10 min

async function ensureContext() {
  if (_context) return _context;

  // launchPersistentContext combina browser + context en uno solo.
  // Usa un directorio de perfil para cookies/localStorage.
  _context = await _chromium.launchPersistentContext(
    path.resolve(config.userDataDir),
    {
      headless: true,
      args: ["--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
      userAgent: config.userAgent,
      viewport: { width: 1366, height: 768 },
      locale: "es-MX",
      timezoneId: "America/Mexico_City",
      // Extra headers que Chrome real siempre envía.
      extraHTTPHeaders: {
        "Accept-Language": "es-MX,es;q=0.9,en;q=0.8",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      },
    },
  );
  log.info("browser context launched", { profileDir: config.userDataDir });
  return _context;
}

export async function closeBrowser() {
  if (_context) {
    await _context.close().catch(() => {});
    _context = null;
    log.info("browser context closed");
  }
}

async function withPage(fn) {
  const ctx = await ensureContext();
  const page = await ctx.newPage();
  try { return await fn(page); }
  finally { await page.close().catch(() => {}); }
}

/** ¿El error sugiere captcha / bloqueo antibot? → merece retry */
function looksLikeAntibotBlock(err) {
  if (!err) return false;
  const s = err.toLowerCase();
  return s.includes("captcha")
      || s.includes("robot check")
      || s.includes("título no encontrado")
      || s.includes("access denied");
}

/**
 * Calienta un dominio nuevo visitando su homepage. Amazon marca los
 * contexts que aterrizan directo en /dp/<ASIN> desde una IP fresca como
 * sospechosos → captcha. Un flow "homepage → producto" parece humano.
 */
async function warmupHost(page, url) {
  let host;
  try { host = new URL(url).hostname; } catch { return; }

  // Re-calentar cada WARMUP_TTL_MS. Amazon marca sospechoso un context que
  // visita N /dp/ en rápida sucesión sin volver a la homepage.
  const last = _warmedAt.get(host) ?? 0;
  if (Date.now() - last < WARMUP_TTL_MS) return;

  const homepage = `https://${host}/`;
  try {
    await page.goto(homepage, { waitUntil: "domcontentloaded", timeout: config.playwrightTimeoutMs });
    await sleep(800 + Math.floor(Math.random() * 400));
    _warmedAt.set(host, Date.now());
    log.debug("host warmed", { host });
  } catch (err) {
    log.warn("warmup failed", { host, err: err.message });
  }
}

async function scrapeOnce(url) {
  return withPage(async (page) => {
    try {
      await warmupHost(page, url);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.playwrightTimeoutMs });

      // Amazon.com (a diferencia de .mx) sirve un shell casi vacío y
      // rellena con JS. Esperar el título o el captcha, lo que aparezca
      // primero. Timeout suave — si no aparece nada la página está mal.
      await page.waitForSelector(
        '#productTitle, form[action*="validateCaptcha"]',
        { timeout: 8000 },
      ).catch(() => {});

      await sleep(400 + Math.floor(Math.random() * 400));
      await page.mouse.wheel(0, 200).catch(() => {});
      await sleep(200);

      // Detección temprana de captcha: si aparece formulario /errors/validateCaptcha.
      const captcha = await page.evaluate(() =>
        document.querySelector('form[action*="validateCaptcha"]') != null ||
        document.title.toLowerCase().includes("robot check"),
      );
      if (captcha) return { error: "Captcha detectado (Amazon Robot Check)" };

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

      if (!title) return { error: "Título no encontrado (posible bloqueo antibot)" };
      if (!priceText) return { error: "Precio no encontrado" };
      const price = Number.parseFloat(priceText.replace(/[^0-9.,]/g, "").replace(",", "."));
      if (Number.isNaN(price) || price <= 0) return { error: `Precio inválido: '${priceText}'` };

      return { title, price, imageUrl };
    } catch (err) {
      return { error: err.message || String(err) };
    }
  });
}

/**
 * Scrapea con reintentos exponenciales solo para errores que huelan a
 * antibot. Errores no-captcha (ej. timeout de red) no se reintentan
 * automáticamente porque no van a resolverse esperando.
 */
export async function scrapeProduct(url) {
  let last;
  for (let attempt = 0; attempt <= config.scrapeRetries; attempt++) {
    last = await scrapeOnce(url);
    if (!last.error) return last;
    if (!looksLikeAntibotBlock(last.error)) return last;   // no reintenta si no huele a antibot
    if (attempt === config.scrapeRetries) break;
    const delayMs = config.scrapeRetryDelayMs * 2 ** attempt;
    log.warn("scrape blocked, retrying", { url, attempt: attempt + 1, delayMs, err: last.error });
    await sleep(delayMs);
  }
  return last;
}
