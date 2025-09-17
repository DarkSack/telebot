# 🤖 Price Tracker Bot

¡Bienvenido al **Price Tracker Bot**\! Este bot de Telegram está diseñado para ayudarte a rastrear los precios de productos en Amazon. Simplemente añádelo a tu chat, envíale la URL de un producto y te notificará automáticamente si el precio baja.

## ✨ Características Principales

- **Rastreo de Precios:** Monitorea el precio de los productos de Amazon que elijas.
- **Alertas de Bajada de Precio:** Recibe una notificación instantánea en Telegram cuando el precio de un producto baja.
- **Resumen Diario:** Obtén un resumen diario visual de todos los productos que estás siguiendo.
- **Gestión Sencilla:** Añade, elimina, edita y revisa productos directamente desde Telegram con comandos intuitivos.
- **Historial de Precios:** El bot guarda el precio más bajo que ha registrado un producto.

## ⚙️ Requisitos

Antes de empezar, asegúrate de tener instalado lo siguiente:

- **Node.js:** Versión 16 o superior.
- **npm:** Se instala junto con Node.js.
- **Google Chrome:** Playwright utiliza Chromium para el web scraping.

## 🚀 Instalación y Configuración

Sigue estos pasos para poner en marcha el bot en tu sistema.

### 1\. Clona el repositorio

Descarga el proyecto en tu máquina local.

```bash
git clone https://github.com/tu-usuario/tu-repositorio.git
cd tu-repositorio
```

### 2\. Instala las dependencias

Instala todas las bibliotecas necesarias.

```bash
npm install
```

### 3\. Configura las variables de entorno

Crea un archivo llamado `.env` en la raíz del proyecto. Este archivo contendrá el token de tu bot de Telegram.

- **Obtén tu token de Telegram:** Habla con el **BotFather** en Telegram para crear un nuevo bot y obtener su token.

- **Añade el token a tu archivo `.env`:**

  ```env
  TELEGRAM_TOKEN=TU_TOKEN_AQUI
  ```

### 4\. Ejecuta el bot

Inicia el bot con el siguiente comando.

```bash
npm start
```

El bot se conectará a Telegram y estará listo para recibir comandos.

## 📋 Comandos del Bot

Interactúa con el bot usando estos comandos en tu chat de Telegram:

- `/start` : Muestra un mensaje de bienvenida con la lista de comandos disponibles.
- `/add [URL]` : Agrega un nuevo producto para rastrear. Simplemente pega la URL del producto de Amazon.
- `/list` : Muestra todos los productos que estás siguiendo en un menú interactivo.
- `/check` : Revisa los precios de todos los productos de inmediato.
- `/edit [URL_ANTIGUA] [URL_NUEVA]` : Actualiza la URL de un producto existente.
- `/remove [URL]` : Elimina un producto de la lista de seguimiento.

## 🛠️ Tecnologías Utilizadas

- **Node.js:** Entorno de ejecución del servidor.
- **node-telegram-bot-api:** Biblioteca para interactuar con la API de Telegram.
- **Playwright:** Herramienta de web scraping para obtener la información de los productos de Amazon.
- **node-cron:** Biblioteca para programar tareas (cronjobs), como la revisión diaria de precios.
- **dotenv:** Para gestionar las variables de entorno de forma segura.

## 🤝 Contribuciones

Si encuentras algún error o tienes una idea para mejorar el bot, ¡las contribuciones son bienvenidas\! Puedes abrir un _issue_ o enviar un _pull request_ en este repositorio.

---

Made with ❤️ by Sack 🤓
