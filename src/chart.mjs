import { chromium } from "playwright";
import { log } from "./logger.mjs";

// ══════════════════════════════════════════════════════════════
// Generación de gráfico de historial con Chart.js.
//
// NOTA: Chart.js se carga desde CDN (jsdelivr) para no bundlear el
// JS. Trade-off: cada gráfico requiere red. Mejora futura: descargar
// el bundle una vez y embeberlo inline.
// ══════════════════════════════════════════════════════════════

export async function generateChartBuffer(labels, prices, title) {
  const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    const html = `<!doctype html>
<html><head><meta charset="utf-8"/><style>body{margin:0;padding:0}</style></head>
<body>
  <canvas id="chart" width="900" height="420"></canvas>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script>
    const labels = ${JSON.stringify(labels)};
    const data   = ${JSON.stringify(prices)};
    const title  = ${JSON.stringify(title || "")};
    new Chart(document.getElementById('chart').getContext('2d'), {
      type: 'line',
      data: { labels, datasets: [{ label: 'Precio', data, borderWidth: 2, tension: 0.2, fill: false }] },
      options: {
        responsive: false,
        plugins: { title: { display: true, text: title } },
        scales: { y: { beginAtZero: false } },
      },
    });
  </script>
</body></html>`;

    await page.setContent(html, { waitUntil: "load" });
    // Espera a que Chart.js exista y renderice.
    await page.waitForFunction(() => !!window.Chart, { timeout: 10_000 });
    await page.waitForTimeout(500);

    const canvas = await page.$("#chart");
    if (!canvas) throw new Error("canvas element not found (Chart.js failed to load)");
    return await canvas.screenshot();
  } catch (err) {
    log.error("chart render failed", { error: err.message });
    throw err;
  } finally {
    await browser.close().catch(() => {});
  }
}
