import { loadConfig } from "../utils/storage.js";
import { getRecentTrades, getTotalProfit } from "../utils/db.js";

const elements = {
  pair: document.getElementById("pair"),
  buyTarget: document.getElementById("buyTarget"),
  sellTarget: document.getElementById("sellTarget"),
  amountUsdt: document.getElementById("amountUsdt"),
  minAmountUsdt: document.getElementById("minAmountUsdt"),
  maxTrades: document.getElementById("maxTrades"),
  maxTradesValue: document.getElementById("maxTradesValue"),
  autoBuy: document.getElementById("autoBuy"),
  autoSell: document.getElementById("autoSell"),
  startBot: document.getElementById("startBot"),
  stopBot: document.getElementById("stopBot"),
  statusDot: document.getElementById("statusDot"),
  statusText: document.getElementById("statusText"),
  errorText: document.getElementById("errorText"),
  tradeLog: document.getElementById("tradeLog"),
  totalProfit: document.getElementById("totalProfit"),
  priceValue: document.getElementById("priceValue"),
  pairLabel: document.getElementById("pairLabel"),
  apiKey: document.getElementById("apiKey"),
  apiSecret: document.getElementById("apiSecret"),
  saveKeysBtn: document.getElementById("saveKeysBtn")
};

let pricePollId = null;

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildConfig() {
  return {
    pair: elements.pair.value.trim().toUpperCase(),
    buyTarget: toNumber(elements.buyTarget.value),
    sellTarget: toNumber(elements.sellTarget.value),
    amountUsdt: toNumber(elements.amountUsdt.value),
    minAmountUsdt: toNumber(elements.minAmountUsdt.value),
    maxTrades: toNumber(elements.maxTrades.value),
    autoBuy: elements.autoBuy.checked,
    autoSell: elements.autoSell.checked
  };
}

function showError(message) {
  elements.errorText.textContent = message || "";
}

function updateStatus(state) {
  elements.statusText.textContent = state;
  elements.statusDot.classList.remove("running", "error");
  if (state === "RUNNING") {
    elements.statusDot.classList.add("running");
  }
  if (state === "ERROR") {
    elements.statusDot.classList.add("error");
  }
}

function updatePrice(price) {
  if (price === null || price === undefined || Number.isNaN(Number(price))) {
    return;
  }
  const formatted = Number(price).toFixed(6);
  if (elements.priceValue.textContent !== formatted) {
    elements.priceValue.textContent = formatted;
    elements.priceValue.classList.add("flash");
    setTimeout(() => elements.priceValue.classList.remove("flash"), 300);
  }
}

function updateTradeTable(trades) {
  elements.tradeLog.innerHTML = "";
  trades.forEach((trade) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${trade.pair}</td>
      <td>${Number(trade.buyPrice).toFixed(6)}</td>
      <td>${Number(trade.sellPrice).toFixed(6)}</td>
      <td>${Number(trade.profit).toFixed(4)}</td>
    `;
    elements.tradeLog.appendChild(row);
  });
}

async function refreshTrades() {
  const trades = await getRecentTrades(20);
  updateTradeTable(trades);
  const totalProfit = await getTotalProfit();
  elements.totalProfit.textContent = Number(totalProfit).toFixed(4);
}

async function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

async function requestStatus() {
  await sendMessage({ type: "getStatus" });
}

async function fetchLivePrice(pair) {
  const targetPair = (pair || elements.pair.value.trim().toUpperCase());
  if (!targetPair) {
    return;
  }
  try {
    const response = await sendMessage({ type: "fetchPrice", payload: { pair: targetPair } });
    if (response?.ok && response.price !== null && response.price !== undefined) {
      updatePrice(response.price);
    } else if (response?.error) {
      elements.priceValue.textContent = "--";
    }
  } catch (err) {
    // Ignore transient errors while popup is open.
  }
}

function startPricePolling() {
  if (pricePollId) {
    return;
  }
  fetchLivePrice();
  pricePollId = setInterval(fetchLivePrice, 5000);
}

async function handleStart() {
  showError("");
  const config = buildConfig();
  if (!config.pair) {
    showError("Currency pair is required.");
    return;
  }
  if (config.amountUsdt <= 0) {
    showError("Amount per trade must be greater than 0.");
    return;
  }
  if (config.buyTarget <= 0 || config.sellTarget <= 0) {
    showError("Buy and sell targets must be greater than 0.");
    return;
  }

  try {
    await sendMessage({ type: "saveConfig", payload: config });
    await sendMessage({ type: "startBot", payload: config });
  } catch (err) {
    showError(err.message || "Failed to start bot.");
  }
}

async function handleStop() {
  showError("");
  try {
    await sendMessage({ type: "stopBot" });
  } catch (err) {
    showError(err.message || "Failed to stop bot.");
  }
}

async function handleSaveKeys() {
  const apiKey = elements.apiKey.value.trim();
  const apiSecret = elements.apiSecret.value.trim();
  if (!apiKey || !apiSecret) {
    showError("Both API Key and Secret are required.");
    return;
  }
  showError("");
  const oldText = elements.saveKeysBtn.textContent;
  elements.saveKeysBtn.textContent = "SAVING...";
  try {
    await sendMessage({ type: "saveKeys", payload: { apiKey, apiSecret } });
    elements.saveKeysBtn.textContent = "SAVED!";
    setTimeout(() => { elements.saveKeysBtn.textContent = oldText; }, 2000);
  } catch (err) {
    showError(err.message || "Failed to save keys.");
    elements.saveKeysBtn.textContent = oldText;
  }
}

function updateConfigUI(config) {
  // Do not overwrite user input if they are currently typing in a text/number field
  if (document.activeElement && 
      document.activeElement.tagName === "INPUT" && 
      (document.activeElement.type === "text" || document.activeElement.type === "number")) {
    return;
  }

  elements.pair.value = config.pair || "";
  elements.buyTarget.value = config.buyTarget ?? "";
  elements.sellTarget.value = config.sellTarget ?? "";
  elements.amountUsdt.value = config.amountUsdt ?? "";
  elements.minAmountUsdt.value = config.minAmountUsdt ?? "";
  elements.maxTrades.value = config.maxTrades ?? 1;
  elements.maxTradesValue.textContent = config.maxTrades ?? 1;
  elements.autoBuy.checked = Boolean(config.autoBuy);
  elements.autoSell.checked = Boolean(config.autoSell);
  elements.pairLabel.textContent = config.pair || "";
}

async function init() {
  const config = await loadConfig();
  updateConfigUI(config);

  try {
    const keyRes = await sendMessage({ type: "getKeys" });
    if (keyRes?.ok && keyRes.keys) {
      if (keyRes.keys.apiKey) {
        elements.apiKey.value = keyRes.keys.apiKey;
      }
      if (keyRes.keys.apiSecret) {
        // Just show asterisks for the secret for security, or the actual secret. Let's show the actual secret so they know it's saved.
        elements.apiSecret.value = keyRes.keys.apiSecret;
      }
    }
  } catch (err) {
    // Ignore if it fails to load keys
  }

  await refreshTrades();
  await requestStatus();
  startPricePolling();
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "statusUpdate") {
    const { botState, config, lastPrice, error } = message.payload;
    if (config) {
      updateConfigUI(config);
    }
    if (botState) {
      updateStatus(botState);
    }
    if (lastPrice) {
      updatePrice(lastPrice);
    }
    if (error) {
      showError(error);
    }
    if (message.payload.tradeCompleted) {
      refreshTrades();
    }
  }
});

elements.maxTrades.addEventListener("input", () => {
  elements.maxTradesValue.textContent = elements.maxTrades.value;
});

elements.pair.addEventListener("change", () => {
  const p = elements.pair.value.trim().toUpperCase();
  elements.pair.value = p;
  elements.pairLabel.textContent = p;
  elements.priceValue.textContent = "--";
  fetchLivePrice(p);
});

elements.pair.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const p = elements.pair.value.trim().toUpperCase();
    elements.pair.value = p;
    elements.pairLabel.textContent = p;
    elements.priceValue.textContent = "--";
    fetchLivePrice(p);
    elements.pair.blur();
  }
});

elements.startBot.addEventListener("click", handleStart);
elements.stopBot.addEventListener("click", handleStop);
elements.saveKeysBtn.addEventListener("click", handleSaveKeys);

init();
