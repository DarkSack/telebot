# 🤖 Price Tracker Bot (telebot)

Bot de **Telegram** que rastrea precios de productos de **Amazon**. Añádelo a tu chat, envía la URL de un producto y recibirás notificaciones automáticas cuando su precio baje.

---

## ✨ Características

- 🛒 **Rastreo de precios** de productos de Amazon.
- 🔔 **Alertas** instantáneas por Telegram cuando el precio baja.
- 📊 **Resumen diario** con el estado de todos los productos que sigues.
- ✏️ **Gestión sencilla** desde Telegram (`/add`, `/list`, `/edit`, `/remove`).
- 🕒 **Cron interno** para revisar precios en intervalos configurables (via `node-cron`).
- 💾 **Historial** del precio más bajo registrado por producto (persistido en `prices.json`).

---

## ⚙️ Requisitos

- **Node.js** ≥ 16
- **npm**
- **Google Chrome / Chromium** (Playwright lo instala automáticamente)

---

## 🚀 Instalación y configuración

### 1. Clonar el repositorio

```bash
git clone https://github.com/DarkSack/telebot.git
cd telebot
```

### 2. Instalar dependencias

```bash
npm install
npx playwright install chromium
```

### 3. Variables de entorno

Crea un archivo `.env` en la raíz:

```env
TELEGRAM_TOKEN=tu_token_de_botfather
# Opcional: ID del chat para envíos automáticos
CHAT_ID=123456789
```

> Habla con [@BotFather](https://t.me/BotFather) en Telegram para crear tu bot y obtener el token.

### 4. Ejecutar

```bash
npm start
```

El bot se conectará a Telegram y quedará listo para recibir comandos.

---

## 📋 Comandos del bot

| Comando                  | Descripción                                                   |
| ------------------------ | ------------------------------------------------------------- |
| `/start`                 | Mensaje de bienvenida y lista de comandos.                    |
| `/add [URL]`             | Añade un producto de Amazon al rastreador.                    |
| `/list`                  | Lista interactiva de todos los productos seguidos.            |
| `/check`                 | Fuerza una revisión inmediata de precios.                     |
| `/edit [URL_old] [URL_new]` | Cambia la URL de un producto existente.                    |
| `/remove [URL]`          | Elimina un producto del rastreo.                              |

---

## 🛠️ Stack

- **Runtime:** Node.js (ESM)
- **Telegram:** `node-telegram-bot-api`
- **Scraping:** `playwright` (Chromium headless)
- **Cron:** `node-cron`
- **HTTP:** `axios` · `node-fetch`
- **Env:** `dotenv`

---

## 📁 Estructura

```
telebot/
├── index.mjs         # Entrada principal (registra comandos + cron)
├── prices.json       # Persistencia del historial de precios
├── package.json
└── .env              # (no versionado)
```

---

## 🤝 Contribuciones

_Issues_ y _pull requests_ son bienvenidos ✨.

---

Made with ❤️ by **Sack** 🤓
