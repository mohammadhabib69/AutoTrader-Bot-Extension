const CONFIG_KEY = "config";
const BOT_STATE_KEY = "botState";
const KEYS_KEY = "apiKeys";
const ENC_KEY_KEY = "encryptionKey";

// Optional: set hardcoded keys for local testing; keep empty in source control.
const STATIC_KEYS = { apiKey: "", apiSecret: "" };

export const DEFAULT_CONFIG = {
  pair: "AVL_USDT",
  buyTarget: 0,
  sellTarget: 0,
  amountUsdt: 10,
  minAmountUsdt: 5,
  maxTrades: 10,
  autoBuy: true,
  autoSell: true
};

export function getStaticKeys() {
  return { ...STATIC_KEYS };
}

function sanitizeNumber(value, fallback) {
  const numberValue = Number(value);
  if (Number.isFinite(numberValue)) {
    return numberValue;
  }
  return fallback;
}

export function validateConfig(rawConfig) {
  const safe = rawConfig || {};
  const maxTrades = Math.max(1, Math.min(200, sanitizeNumber(safe.maxTrades, 10)));

  return {
    pair: typeof safe.pair === "string" ? safe.pair.trim().toUpperCase() : DEFAULT_CONFIG.pair,
    buyTarget: sanitizeNumber(safe.buyTarget, DEFAULT_CONFIG.buyTarget),
    sellTarget: sanitizeNumber(safe.sellTarget, DEFAULT_CONFIG.sellTarget),
    amountUsdt: sanitizeNumber(safe.amountUsdt, DEFAULT_CONFIG.amountUsdt),
    minAmountUsdt: sanitizeNumber(safe.minAmountUsdt, DEFAULT_CONFIG.minAmountUsdt),
    maxTrades,
    autoBuy: safe.autoBuy ?? DEFAULT_CONFIG.autoBuy,
    autoSell: safe.autoSell ?? DEFAULT_CONFIG.autoSell
  };
}

export async function saveConfig(config) {
  const validated = validateConfig(config);
  await chrome.storage.local.set({ [CONFIG_KEY]: validated });
  return validated;
}

export async function loadConfig() {
  const result = await chrome.storage.local.get(CONFIG_KEY);
  return validateConfig(result[CONFIG_KEY] || DEFAULT_CONFIG);
}

export async function saveBotState(state) {
  await chrome.storage.local.set({ [BOT_STATE_KEY]: state });
}

export async function loadBotState() {
  const result = await chrome.storage.local.get(BOT_STATE_KEY);
  return result[BOT_STATE_KEY] || "STOPPED";
}

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function getOrCreateEncryptionKey() {
  const stored = await chrome.storage.local.get(ENC_KEY_KEY);
  if (stored[ENC_KEY_KEY]) {
    return crypto.subtle.importKey(
      "jwk",
      stored[ENC_KEY_KEY],
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"]
    );
  }

  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
  const exported = await crypto.subtle.exportKey("jwk", key);
  await chrome.storage.local.set({ [ENC_KEY_KEY]: exported });
  return key;
}

async function encryptText(plainText) {
  const key = await getOrCreateEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plainText);
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded
  );
  return {
    iv: bufferToBase64(iv.buffer),
    data: bufferToBase64(cipher)
  };
}

async function decryptText(payload) {
  if (!payload || !payload.iv || !payload.data) {
    return "";
  }
  const key = await getOrCreateEncryptionKey();
  const iv = new Uint8Array(base64ToBuffer(payload.iv));
  const data = base64ToBuffer(payload.data);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    data
  );
  return new TextDecoder().decode(decrypted);
}

export async function saveEncryptedKeys({ apiKey, apiSecret }) {
  const encryptedKey = await encryptText(apiKey || "");
  const encryptedSecret = await encryptText(apiSecret || "");
  await chrome.storage.local.set({
    [KEYS_KEY]: { apiKey: encryptedKey, apiSecret: encryptedSecret }
  });
}

export async function loadEncryptedKeys() {
  const result = await chrome.storage.local.get(KEYS_KEY);
  return result[KEYS_KEY] || null;
}

export async function decryptStoredKeys() {
  const stored = await loadEncryptedKeys();
  if (!stored) {
    return { apiKey: "", apiSecret: "" };
  }
  const apiKey = await decryptText(stored.apiKey);
  const apiSecret = await decryptText(stored.apiSecret);
  return { apiKey, apiSecret };
}

export async function saveSessionKeys({ apiKey, apiSecret }) {
  await chrome.storage.session.set({ apiKey, apiSecret });
}

export async function getSessionKeys() {
  const result = await chrome.storage.session.get(["apiKey", "apiSecret"]);
  return {
    apiKey: result.apiKey || "",
    apiSecret: result.apiSecret || ""
  };
}

export async function clearSessionKeys() {
  await chrome.storage.session.remove(["apiKey", "apiSecret"]);
}
