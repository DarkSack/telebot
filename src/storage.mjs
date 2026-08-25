import { readFile, writeFile, rename, access } from "node:fs/promises";
import { constants } from "node:fs";
import { config } from "./config.mjs";
import { log } from "./logger.mjs";
import { debounce } from "./utils.mjs";

// ══════════════════════════════════════════════════════════════
// Persistencia atómica de prices.json.
// - write en tempfile → rename → nunca queda un JSON truncado si
//   el proceso muere mid-write.
// - saveData debounced 500ms para evitar N writes por ráfaga.
// ══════════════════════════════════════════════════════════════

const state = {
  products: /** @type {Record<string, any>} */ ({}),
  chats:    /** @type {Set<number>} */ (new Set()),
};

export async function loadData() {
  try {
    await access(config.dataFile, constants.R_OK);
  } catch {
    log.info("data file missing, starting empty", { file: config.dataFile });
    return state;
  }
  try {
    const raw = await readFile(config.dataFile, "utf8");
    const parsed = JSON.parse(raw);
    state.products = parsed.products ?? {};
    state.chats    = new Set(parsed.chats ?? []);
    log.info("data loaded", { products: Object.keys(state.products).length, chats: state.chats.size });
  } catch (err) {
    log.error("data load failed", { error: err.message });
    // No sobreescribimos silenciosamente — el usuario debe intervenir.
    throw new Error(`Failed to load ${config.dataFile}: ${err.message}`);
  }
  return state;
}

async function writeAtomically(payload) {
  const tmp = `${config.dataFile}.tmp`;
  await writeFile(tmp, payload, "utf8");
  await rename(tmp, config.dataFile);
}

// Write real. No hay debounce en esta versión para que puedas awaitear si necesitas.
export async function saveDataNow() {
  try {
    const payload = JSON.stringify({
      products: state.products,
      chats:    [...state.chats],
    }, null, 2);
    await writeAtomically(payload);
    log.debug("data saved", { products: Object.keys(state.products).length });
  } catch (err) {
    log.error("data save failed", { error: err.message });
  }
}

// Fire-and-forget debounced: perfecto para "usuario mandó mensaje → save"
// donde no importa esperar al disco.
export const saveDataDebounced = debounce(() => { void saveDataNow(); }, 500);

// Acceso al state — inmutabilidad no impuesta pero los callers deberían
// mutar solo a través de las helpers.
export function getState() { return state; }
export function getProduct(key) { return state.products[key]; }
export function setProduct(key, product) { state.products[key] = product; }
export function deleteProduct(key) { delete state.products[key]; }
export function listProductKeys() { return Object.keys(state.products); }
export function registerChat(id) {
  if (state.chats.has(id)) return false;
  state.chats.add(id);
  return true;
}
export function listChats() { return [...state.chats]; }
