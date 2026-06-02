const BASE_URL = "https://api.gateio.ws/api/v4";
const RETRY_LIMIT = 3;
const RATE_LIMIT_DELAY_MS = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha512Hex(message) {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hash = await crypto.subtle.digest("SHA-512", data);
  return toHex(hash);
}

async function hmacSha512Hex(secret, message) {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(message)
  );
  return toHex(signature);
}

function buildQueryString(query) {
  if (!query || Object.keys(query).length === 0) {
    return "";
  }
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      params.append(key, String(value));
    }
  });
  return params.toString();
}

async function signedRequest({ method, path, query, body, apiKey, apiSecret }) {
  if (!apiKey || !apiSecret) {
    throw new Error("Missing API credentials.");
  }

  const queryString = buildQueryString(query);
  const bodyString = body ? JSON.stringify(body) : "";
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyHash = await sha512Hex(bodyString);
  const pathForSign = `/api/v4${path}`;

  const signPayload = [
    method.toUpperCase(),
    pathForSign,
    queryString,
    bodyHash,
    timestamp
  ].join("\n");

  const signature = await hmacSha512Hex(apiSecret, signPayload);

  const url = `${BASE_URL}${path}${queryString ? `?${queryString}` : ""}`;
  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      KEY: apiKey,
      SIGN: signature,
      Timestamp: timestamp
    },
    body: bodyString || undefined
  });

  return response;
}

async function publicRequest({ method, path, query }) {
  const queryString = buildQueryString(query);
  const url = `${BASE_URL}${path}${queryString ? `?${queryString}` : ""}`;
  return fetch(url, { method });
}

async function requestWithRetry(requestFn, parseJson = true) {
  let attempt = 0;
  let lastError = null;

  while (attempt < RETRY_LIMIT) {
    try {
      const response = await requestFn();
      if (response.status === 429) {
        await sleep(RATE_LIMIT_DELAY_MS);
        attempt += 1;
        continue;
      }

      if (!response.ok) {
        const message = await response.text();
        throw new Error(`API error ${response.status}: ${message}`);
      }

      if (!parseJson) {
        return null;
      }

      return await response.json();
    } catch (err) {
      lastError = err;
      const backoff = 500 * Math.pow(2, attempt);
      await sleep(backoff);
      attempt += 1;
    }
  }

  throw lastError || new Error("Request failed.");
}

export async function getPrice(pair) {
  // Try direct ticker endpoint first (path segment)
  try {
    const data = await requestWithRetry(() =>
      publicRequest({
        method: "GET",
        path: `/spot/tickers`,
        query: { currency_pair: pair }
      })
    );
    if (Array.isArray(data) && data.length > 0 && data[0].last) {
      return Number(data[0].last);
    }
    if (data && data.last) {
      return Number(data.last);
    }
  } catch (_) {
    // fall through
  }
  throw new Error("Price not available.");
}

export async function getPairInfo(pair) {
  // Gate.io v4: GET /spot/currency_pairs/{currency_pair}
  try {
    const data = await requestWithRetry(() =>
      publicRequest({
        method: "GET",
        path: `/spot/currency_pairs/${encodeURIComponent(pair)}`
      })
    );
    if (data && data.id) {
      return data;
    }
  } catch (_) {
    // fall through to list search
  }

  // Fallback: fetch full list and find the pair
  const list = await requestWithRetry(() =>
    publicRequest({
      method: "GET",
      path: "/spot/currency_pairs"
    })
  );
  if (Array.isArray(list)) {
    return list.find((p) => p.id === pair || p.currency_pair === pair) || null;
  }
  return null;
}

export async function placeOrder({ side, pair, price, amount, amountUsdt, apiKey, apiSecret }) {
  const body = {
    currency_pair: pair,
    side,
    type: "market",
    time_in_force: "ioc"
  };

  // For Gate.io market orders: 
  // - Buy amount is the quote currency (e.g. USDT)
  // - Sell amount is the base currency (e.g. BTC)
  if (side === "buy") {
    body.amount = String(amountUsdt);
  } else {
    body.amount = String(amount);
  }

  return requestWithRetry(() =>
    signedRequest({
      method: "POST",
      path: "/spot/orders",
      body,
      apiKey,
      apiSecret
    })
  );
}

export async function getOrderStatus({ orderId, pair, apiKey, apiSecret }) {
  return requestWithRetry(() =>
    signedRequest({
      method: "GET",
      path: `/spot/orders/${orderId}`,
      query: { currency_pair: pair },
      apiKey,
      apiSecret
    })
  );
}

export async function cancelOrder({ orderId, pair, apiKey, apiSecret }) {
  return requestWithRetry(
    () =>
      signedRequest({
        method: "DELETE",
        path: `/spot/orders/${orderId}`,
        query: { currency_pair: pair },
        apiKey,
        apiSecret
      }),
    true
  );
}

export async function getBalance({ apiKey, apiSecret }) {
  return requestWithRetry(() =>
    signedRequest({
      method: "GET",
      path: "/spot/accounts",
      apiKey,
      apiSecret
    })
  );
}
