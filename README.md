# telebot — Rastreador de precios de Amazon por Telegram

Bot personal de Telegram que **vigila los precios de productos de Amazon** por ti. Le pegas la URL de un producto, el bot lo scrape periódicamente y te avisa **por chat** cuando el precio baja. Guarda historial del precio más bajo registrado y te manda un resumen diario con el estado de todos los productos que sigues.

Ideal para no perderse esa oferta que llevas semanas esperando sin tener que revisar Amazon a mano todos los días.

---

## Cómo se usa

1. **Instala** el bot en tu chat de Telegram (búscalo por su usuario o pon el token en tu propia instancia — ver setup).
2. Envía `/start` para ver el menú.
3. Añade productos con `/add <URL>` — el bot los guarda y arranca a vigilarlos.
4. Cada vez que uno baja de precio, recibes una notificación con el precio nuevo, el anterior y el enlace al producto.
5. Cada día a una hora fija, un **resumen** con todos los productos que sigues y su estado.

### Comandos

| Comando                     | Función                                                              |
| --------------------------- | -------------------------------------------------------------------- |
| `/start`                    | Mensaje de bienvenida + lista de comandos.                           |
| `/add <URL>`                | Añade un producto de Amazon al rastreador.                           |
| `/list`                     | Lista interactiva de todos los productos que sigues.                 |
| `/check`                    | Fuerza una revisión inmediata (sin esperar al cron).                 |
| `/edit <URL_old> <URL_new>` | Reemplaza la URL de un producto por otra.                            |
| `/remove <URL>`             | Deja de rastrear un producto.                                        |

---

## Bajo el capó

- **Bot:** `node-telegram-bot-api` en modo **polling** (no requiere webhook público).
- **Scraper:** **Playwright** (Chromium headless) — visita cada producto, extrae `title` + precio con selectores robustos y sanitiza la URL de Amazon (le corta query strings y hash para deduplicar).
- **Persistencia:** `prices.json` en disco — guarda:
  ```json
  {
    "products": {
      "https://www.amazon.es/dp/XYZ": {
        "title": "…",
        "lowest": 24.99,
        "lastPrice": 27.50,
        "history": [...],
        "createdAt": "..."
      }
    },
    "chats": [123456789]
  }
  ```
- **Cron:** `node-cron` — revisiones periódicas + resumen diario a hora fija.
- **HTTP auxiliar:** `axios` / `node-fetch` para llamadas puntuales fuera del scrape.

---

## Setup local

### Requisitos

- Node.js ≥ 16
- Chromium (Playwright lo instala solo con `npx playwright install`)

### Pasos

```bash
git clone https://github.com/DarkSack/telebot.git
cd telebot
npm install
npx playwright install chromium
```

Crea un `.env` en la raíz:

```env
TELEGRAM_TOKEN=xxxxxxxxx:AAA...    # Token de tu bot (habla con @BotFather)
```

Arranca:

```bash
npm start
# → Bot online, escuchando comandos en Telegram
```

---

## Estructura

```
telebot/
├── index.mjs        # Bot + comandos + cron + scraper (todo en un archivo)
├── prices.json      # Persistencia (se crea al vuelo)
├── package.json
└── .env             # No versionado
```

---

Made with ❤️ by **Sack** 🤓
