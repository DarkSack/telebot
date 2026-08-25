// ══════════════════════════════════════════════════════════════
// Helpers puros — sin side effects, sin state.
// ══════════════════════════════════════════════════════════════

/**
 * Sanea URL de Amazon manteniendo el path canónico. IMPORTANTE:
 * conserva `th=1&psc=1` porque son selectores de variante en Amazon
 * (color/tamaño con precios distintos). Solo elimina tracking (`ref`,
 * `qid`, `tag`, `_encoding`, `pd_rd_*`, etc.).
 */
export function sanitizeAmazonURL(url) {
  try {
    const u = new URL(url);
    const KEEP = new Set(["th", "psc"]);
    for (const k of [...u.searchParams.keys()]) {
      if (!KEEP.has(k)) u.searchParams.delete(k);
    }
    return u.origin + u.pathname + (u.searchParams.size ? "?" + u.searchParams : "");
  } catch {
    return url.split("?")[0];
  }
}

/** Escape para MarkdownV1 de Telegram. Cubre chars que rompen el parser. */
export function escapeMD(text = "") {
  return String(text).replace(/([\\_*\[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

/** Trunca con ellipsis real (`…`) preservando límite en chars. */
export function truncate(text, max) {
  const s = String(text ?? "");
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/** Sleep basado en promesa. */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Debounce con trailing edge — la última llamada dentro de `wait`ms
 * se ejecuta después del silencio. Útil para saveData bajo ráfaga.
 */
export function debounce(fn, wait) {
  let timer = null;
  return function debounced(...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, wait);
  };
}

/** Detecta la moneda a partir del host de Amazon (aproximación decente). */
export function currencyFromUrl(url) {
  try {
    const h = new URL(url).hostname;
    if (h.endsWith(".mx")) return "MXN";
    if (h.endsWith(".es") || h.endsWith(".de") || h.endsWith(".fr") || h.endsWith(".it")) return "EUR";
    if (h.endsWith(".co.uk")) return "GBP";
    if (h.endsWith(".ca")) return "CAD";
    if (h.endsWith(".com.br")) return "BRL";
    if (h.endsWith(".co.jp")) return "JPY";
    return "USD";
  } catch { return "USD"; }
}
