const DB_NAME = "autotrader-db";
const DB_VERSION = 1;
const STORE_NAME = "trades";

let dbPromise = null;

function openDatabase() {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("timestamp", "timestamp");
        store.createIndex("pair", "pair");
        store.createIndex("profit", "profit");
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

async function withStore(mode, callback) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    const request = callback(store);

    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function addTrade(trade) {
  return withStore("readwrite", (store) => store.put(trade));
}

export async function getRecentTrades(limit = 20) {
  const results = [];
  await withStore("readonly", (store) => {
    const index = store.index("timestamp");
    const request = index.openCursor(null, "prev");
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || results.length >= limit) {
        return;
      }
      results.push(cursor.value);
      cursor.continue();
    };
    return request;
  });
  return results;
}

export async function getTotalProfit() {
  let total = 0;
  await withStore("readonly", (store) => {
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        return;
      }
      total += Number(cursor.value.profit || 0);
      cursor.continue();
    };
    return request;
  });
  return total;
}
