import {
  getPrice,
  getPairInfo,
  placeOrder
} from "../utils/gateio-api.js";
import { OrderManager } from "../utils/order-manager.js";
import {
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
  loadBotState,
  saveBotState,
  saveEncryptedKeys,
  decryptStoredKeys,
  getStaticKeys,
  getSessionKeys,
  saveSessionKeys,
  clearSessionKeys
} from "../utils/storage.js";
import { addTrade, getTotalProfit } from "../utils/db.js";

const ALARM_NAME = "autotrader-tick";
const KEEPALIVE_MINUTES = 0.5;   // 30s alarm just to keep service worker alive
const TICK_INTERVAL_MS  = 1000;  // Actual trade check every 1 second
const ORDER_SNAPSHOT_KEY = "orderSnapshot";

const orderManager = new OrderManager();
let currentConfig = { ...DEFAULT_CONFIG };
let botState = "STOPPED";
let lastPrice = null;
let tickRunning = false;
let ordersDirty = false;
const pairInfoCache = new Map();
const PAIR_INFO_TTL_MS = 5 * 60 * 1000;

async function loadOrderSnapshot() {
  const result = await chrome.storage.local.get(ORDER_SNAPSHOT_KEY);
  return result[ORDER_SNAPSHOT_KEY] || null;
}

async function saveOrderSnapshot() {
  await chrome.storage.local.set({
    [ORDER_SNAPSHOT_KEY]: orderManager.toJSON()
  });
}

function markOrdersDirty() {
  ordersDirty = true;
}

async function flushOrderSnapshot() {
  if (!ordersDirty) {
    return;
  }
  ordersDirty = false;
  await saveOrderSnapshot();
}

async function initialize() {
  currentConfig = await loadConfig();
  botState = await loadBotState();
  const snapshot = await loadOrderSnapshot();
  orderManager.loadFromJSON(snapshot);

  if (botState === "RUNNING") {
    ensureAlarm();
  }
}

const initPromise = initialize();

let tickIntervalId = null;

function startTickInterval() {
  if (tickIntervalId) return; // already running
  tickIntervalId = setInterval(() => { handleTick(); }, TICK_INTERVAL_MS);
}

function stopTickInterval() {
  if (tickIntervalId) {
    clearInterval(tickIntervalId);
    tickIntervalId = null;
  }
}

function ensureAlarm() {
  // Keep-alive alarm (30s) so Chrome doesn't terminate the service worker
  chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: KEEPALIVE_MINUTES,
    delayInMinutes: KEEPALIVE_MINUTES
  });
  // Start the 1-second tick loop
  startTickInterval();
}

async function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon-128.png",
    title,
    message
  });
}

async function sendStatusUpdate(extra = {}) {
  const stats = orderManager.getStats();
  const totalProfit = await getTotalProfit();
  const payload = {
    botState,
    config: currentConfig,
    stats: { ...stats, totalProfit },
    lastPrice,
    ...extra
  };

  try {
    await chrome.runtime.sendMessage({ type: "statusUpdate", payload });
  } catch (err) {
    // Popup may be closed; ignore.
  }
}

function calcBaseAmount(amountUsdt, price) {
  if (!price || price <= 0) {
    return 0;
  }
  const raw = amountUsdt / price;
  return Number(raw.toFixed(6));
}

function getPrecision(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function truncateToPrecision(value, precision) {
  if (precision === null || precision === undefined) {
    return value;
  }
  const factor = Math.pow(10, precision);
  return Math.floor(value * factor) / factor;
}

async function getCachedPairInfo(pair) {
  const cached = pairInfoCache.get(pair);
  const now = Date.now();
  if (cached && now - cached.timestamp < PAIR_INFO_TTL_MS) {
    return cached.data;
  }
  const data = await getPairInfo(pair);
  if (!data) {
    throw new Error(`Unknown currency pair: ${pair}`);
  }
  pairInfoCache.set(pair, { data, timestamp: now });
  return data;
}

function normalizeOrderParams({ price, amountBase, pairInfo }) {
  const pricePrecision = getPrecision(
    pairInfo?.price_precision ?? pairInfo?.precision ?? pairInfo?.precision_price
  );
  const amountPrecision = getPrecision(
    pairInfo?.amount_precision ?? pairInfo?.precision_amount
  );

  const normalizedPrice = truncateToPrecision(Number(price), pricePrecision);
  const normalizedAmount = truncateToPrecision(Number(amountBase), amountPrecision);

  if (!Number.isFinite(normalizedPrice) || normalizedPrice <= 0) {
    throw new Error("Invalid price value.");
  }

  if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
    throw new Error("Invalid amount value.");
  }

  const minBase = Number(pairInfo?.min_base_amount || 0);
  const minQuote = Number(pairInfo?.min_quote_amount || 0);
  const maxBase = Number(pairInfo?.max_base_amount || 0);
  const maxQuote = Number(pairInfo?.max_quote_amount || 0);
  const quoteValue = normalizedAmount * normalizedPrice;

  if (minBase && normalizedAmount < minBase) {
    throw new Error(`Amount too small. Min base amount: ${minBase}`);
  }
  if (minQuote && quoteValue < minQuote) {
    throw new Error(`Order value too small. Min quote amount: ${minQuote}`);
  }
  if (maxBase && normalizedAmount > maxBase) {
    throw new Error(`Amount too large. Max base amount: ${maxBase}`);
  }
  if (maxQuote && quoteValue > maxQuote) {
    throw new Error(`Order value too large. Max quote amount: ${maxQuote}`);
  }

  return {
    price: pricePrecision !== null ? normalizedPrice.toFixed(pricePrecision) : String(normalizedPrice),
    amount: amountPrecision !== null ? normalizedAmount.toFixed(amountPrecision) : String(normalizedAmount),
    amountValue: normalizedAmount
  };
}

function isOrderFilled(status) {
  if (!status) {
    return false;
  }
  if (status.status === "closed" || status.status === "filled") {
    return true;
  }
  const filled = Number(status.filled_amount || 0);
  const amount = Number(status.amount || 0);
  return amount > 0 && filled >= amount;
}

async function checkAndSell(orderId, order, price, config, credentials) {
  if (order.phase !== "WAITING_SELL") return;

  if (config.autoSell && order.sellTarget > 0 && price >= order.sellTarget) {
    try {
      const sellResponse = await placeOrder({
        side: "sell",
        pair: order.pair,
        amount: order.amount,
        apiKey: credentials.apiKey,
        apiSecret: credentials.apiSecret
      });

      // Read actual fill from response — never fall back to expected amount
      const filledBase = Number(sellResponse.filled_amount);
      const fillPrice  = Number(sellResponse.avg_deal_price || sellResponse.fill_price || price);

      if (filledBase > 0) {
        const profit = (fillPrice - order.buyPrice) * filledBase;
        const timestamp = Date.now();
        const trade = orderManager.recordCompletedTrade({
          pair: order.pair,
          buyPrice: order.buyPrice,
          sellPrice: fillPrice,
          amount: filledBase,
          profit,
          timestamp
        });
        await addTrade(trade);
        orderManager.removeOrder(orderId);
        markOrdersDirty();
        await notify("Trade completed ✅", `${order.pair} | Profit: ${profit.toFixed(4)} USDT`);
        await sendStatusUpdate({ tradeCompleted: trade });
      } else {
        // Sell order was rejected or zero-filled — keep position alive, retry next tick
        console.warn(`[Sell] Zero fill for order ${orderId}, will retry next tick.`);
      }
    } catch (err) {
      // Sell failed (network/API error) — keep position alive, bot continues running
      console.error(`[Sell] Error for order ${orderId}:`, err.message);
      await notify("Sell failed ⚠️", `Will retry: ${err.message}`);
    }
  }
}

let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 5;

async function checkAndTrade(config) {
  const credentials = await resolveCredentials();

  const price = await getPrice(config.pair);
  lastPrice = price;
  await sendStatusUpdate({ price });

  const pairInfo = await getCachedPairInfo(config.pair);

  // --- SELL LOGIC: check all open positions ---
  const entries = Array.from(orderManager.activeOrders.entries());
  const sellChecks = entries.map(([id, order]) =>
    checkAndSell(id, order, price, config, credentials)
  );
  await Promise.all(sellChecks);

  // --- BUY LOGIC ---
  // Only 1 buy per tick maximum to prevent flooding
  const openSlots = config.maxTrades - orderManager.activeOrders.size;
  if (
    openSlots > 0 &&
    config.autoBuy &&
    config.buyTarget > 0 &&
    config.sellTarget > 0 &&
    price <= config.buyTarget &&
    config.amountUsdt >= config.minAmountUsdt
  ) {
    const buyResponse = await placeOrder({
      side: "buy",
      pair: config.pair,
      amountUsdt: config.amountUsdt,
      apiKey: credentials.apiKey,
      apiSecret: credentials.apiSecret
    });

    // Only use actual filled_amount — never fall back to expected
    const filledBase = Number(buyResponse.filled_amount);
    const fillPrice  = Number(buyResponse.avg_deal_price || buyResponse.fill_price || price);

    if (filledBase > 0) {
      const positionId = String(buyResponse.id || buyResponse.order_id || Date.now());
      orderManager.addOrder(positionId, {
        pair: config.pair,
        side: "buy",
        price: fillPrice,
        amount: filledBase,
        timestamp: Date.now(),
        sellTarget: config.sellTarget,
        phase: "WAITING_SELL",
        buyPrice: fillPrice,
        state: "FILLED"
      });
      markOrdersDirty();
      await notify("Buy executed ✅", `${config.pair} | ${filledBase} @ ${fillPrice}`);
    }
  }

  await flushOrderSnapshot();
}


async function resolveCredentials() {
  const staticKeys = getStaticKeys();
  if (staticKeys.apiKey && staticKeys.apiSecret) {
    return staticKeys;
  }

  const session = await getSessionKeys();
  if (session.apiKey && session.apiSecret) {
    return session;
  }

  const stored = await decryptStoredKeys();
  if (stored.apiKey && stored.apiSecret) {
    await saveSessionKeys(stored);
    return stored;
  }

  throw new Error("Missing API credentials. Save your keys in the popup or set static keys in code.");
}

async function startBot(config) {
  currentConfig = await saveConfig(config);
  botState = "RUNNING";
  await saveBotState(botState);
  ensureAlarm();
  await sendStatusUpdate();
}

async function stopBot(reason) {
  botState = "STOPPED";
  await saveBotState(botState);
  await clearSessionKeys();
  stopTickInterval();                  // Stop the 1-second loop
  chrome.alarms.clear(ALARM_NAME);    // Stop the keep-alive alarm
  await sendStatusUpdate({ reason });
  await notify("Bot stopped", reason || "Bot stopped by user");
}

async function handleTick() {
  await initPromise;
  if (botState !== "RUNNING") {
    return;
  }
  if (tickRunning) {
    return;
  }
  tickRunning = true;
  try {
    await checkAndTrade(currentConfig);
    consecutiveErrors = 0; // Reset on success
    if (botState !== "RUNNING") {
      botState = "RUNNING";
      await saveBotState(botState);
    }
  } catch (err) {
    consecutiveErrors += 1;
    await notify("Bot error ⚠️", `(${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}) ${err.message || "Unknown error"}`);
    await sendStatusUpdate({ error: err.message || String(err) });

    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      // Too many errors — stop the bot to prevent runaway behaviour
      botState = "ERROR";
      await saveBotState(botState);
      await stopBot(`Stopped after ${MAX_CONSECUTIVE_ERRORS} consecutive errors: ${err.message}`);
    }
    // Otherwise keep botState as RUNNING and retry next tick
  } finally {
    tickRunning = false;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  initPromise.catch(() => undefined);
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    // Keep-alive fired — if bot is running but interval was lost (SW suspended), restart it
    await initPromise;
    if (botState === "RUNNING" && !tickIntervalId) {
      startTickInterval();
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    await initPromise;
    switch (message.type) {
      case "getStatus": {
        await sendStatusUpdate();
        sendResponse({ ok: true });
        break;
      }
      case "saveConfig": {
        currentConfig = await saveConfig(message.payload);
        sendResponse({ ok: true, config: currentConfig });
        break;
      }
      case "getKeys": {
        const staticKeys = getStaticKeys();
        if (staticKeys.apiKey && staticKeys.apiSecret) {
          sendResponse({ ok: true, keys: staticKeys });
        } else {
          const decrypted = await decryptStoredKeys();
          sendResponse({ ok: true, keys: decrypted });
        }
        break;
      }
      case "saveKeys": {
        await saveEncryptedKeys(message.payload);
        await saveSessionKeys(message.payload);
        sendResponse({ ok: true });
        break;
      }
      case "fetchPrice": {
        const pair = message.payload?.pair || currentConfig.pair;
        if (!pair) {
          sendResponse({ ok: false, error: "Currency pair is required." });
          break;
        }
        try {
          const price = await getPrice(pair);
          lastPrice = price;
          sendResponse({ ok: true, price });
        } catch (err) {
          sendResponse({ ok: false, error: err.message || String(err) });
        }
        break;
      }
      case "startBot": {
        const decrypted = await decryptStoredKeys();
        await saveSessionKeys(decrypted);
        await startBot(message.payload || currentConfig);
        sendResponse({ ok: true });
        break;
      }
      case "stopBot": {
        await stopBot("Stopped by user");
        sendResponse({ ok: true });
        break;
      }
      default: {
        sendResponse({ ok: false, error: "Unknown message" });
      }
    }
  })();
  return true;
});
