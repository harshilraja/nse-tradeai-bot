// ═══════════════════════════════════════════════════════════════════════════
// NSE TradeAI · OPTIMIZED Balance Check
// Smart pre-trade validation with margin awareness & auto qty reduction
// ═══════════════════════════════════════════════════════════════════════════

import axios from "axios";

const CONFIG = {
  MIN_CASH_BUFFER:        5000,     // Never use last ₹5,000
  MAX_CAPITAL_PER_TRADE:  0.30,     // 30% max per trade
  MAX_TOTAL_EXPOSURE:     0.80,     // 80% max total
  MIS_LEVERAGE:           5,         // Angel gives 5x intraday leverage
  BALANCE_CACHE_MS:       30000,    // 30s cache (reduce API calls)
};

let cachedBalance = null;
let cacheTime = 0;

function angelHeaders(jwt, apiKey) {
  return {
    "Authorization": `Bearer ${jwt}`, "Content-Type": "application/json",
    "Accept": "application/json", "X-UserType": "USER", "X-SourceID": "WEB",
    "X-ClientLocalIP": "192.168.1.1", "X-ClientPublicIP": "103.0.0.1",
    "X-MACAddress": "00:00:00:00:00:00", "X-PrivateKey": apiKey,
  };
}

// ═══ FETCH LIVE BALANCE ════════════════════════════════════════════════════
export async function fetchLiveBalance(jwtToken, apiKey, forceFresh = false) {
  const age = Date.now() - cacheTime;
  if (!forceFresh && cachedBalance && age < CONFIG.BALANCE_CACHE_MS) {
    return cachedBalance;
  }

  try {
    const res = await axios.get(
      "https://apiconnect.angelbroking.com/rest/secure/angelbroking/user/v1/getRMS",
      { headers: angelHeaders(jwtToken, apiKey), timeout: 8000 }
    );
    const d = res.data?.data || {};
    cachedBalance = {
      availableCash:  parseFloat(d.availablecash || 0),
      utilisedMargin: parseFloat(d.utiliseddebits || 0),
      netAvailable:   parseFloat(d.net || 0),
      collateral:     parseFloat(d.collateral || 0),
      realisedMTM:    parseFloat(d.m2mrealised || 0),
      unrealisedMTM:  parseFloat(d.m2munrealised || 0),
      openingBalance: parseFloat(d.openingbalance || 0),
      intradayPayin:  parseFloat(d.availableintradaypayin || 0),
      updatedAt:      new Date().toISOString(),
    };
    cacheTime = Date.now();
    return cachedBalance;
  } catch (e) {
    console.error("fetchLiveBalance error:", e.message);
    return cachedBalance || { availableCash: 0, error: e.message };
  }
}

// ═══ SMART PRE-TRADE CHECK ═════════════════════════════════════════════════
export async function smartBalanceCheck(signal, jwtToken, apiKey) {
  const balance = await fetchLiveBalance(jwtToken, apiKey, true);
  const available = balance.availableCash || 0;
  const utilised = balance.utilisedMargin || 0;
  const total = available + utilised;

  // Required capital varies by order type
  const isIntraday = signal.orderType === "INTRADAY" || signal.orderType === "MIS";
  const capitalNeeded = signal.qty * signal.entry;
  const marginNeeded = isIntraday
    ? capitalNeeded / CONFIG.MIS_LEVERAGE  // 1/5th for intraday
    : capitalNeeded;                       // Full for delivery

  const availableAfterBuffer = available - CONFIG.MIN_CASH_BUFFER;
  const maxPerTrade = available * CONFIG.MAX_CAPITAL_PER_TRADE;
  const newExposurePct = total > 0 ? (utilised + marginNeeded) / total : 1;

  // ═══ CHECK 1: Sufficient cash ═══
  if (availableAfterBuffer < marginNeeded) {
    // Try auto-reduce qty
    const maxAffordableQty = Math.floor(availableAfterBuffer / (isIntraday ? signal.entry / CONFIG.MIS_LEVERAGE : signal.entry));

    if (maxAffordableQty < 1) {
      return {
        approved: false,
        reason: "INSUFFICIENT_CASH",
        message: `Need ₹${marginNeeded.toFixed(0)} margin · only ₹${availableAfterBuffer.toFixed(0)} available after ₹${CONFIG.MIN_CASH_BUFFER} safety buffer`,
        balance, originalQty: signal.qty, suggestedQty: 0,
      };
    }

    return {
      approved: true,
      adjusted: true,
      reason: "QTY_REDUCED_INSUFFICIENT_CASH",
      message: `Qty reduced from ${signal.qty} to ${maxAffordableQty} due to cash constraint`,
      balance, originalQty: signal.qty, suggestedQty: maxAffordableQty,
      newMarginNeeded: maxAffordableQty * (isIntraday ? signal.entry / CONFIG.MIS_LEVERAGE : signal.entry),
    };
  }

  // ═══ CHECK 2: Per-trade capital limit (30%) ═══
  if (marginNeeded > maxPerTrade) {
    const maxAffordableQty = Math.floor(maxPerTrade / (isIntraday ? signal.entry / CONFIG.MIS_LEVERAGE : signal.entry));

    if (maxAffordableQty < 1) {
      return {
        approved: false,
        reason: "EXCEEDS_PER_TRADE_LIMIT",
        message: `Trade needs ${((marginNeeded/available)*100).toFixed(0)}% of capital · max ${CONFIG.MAX_CAPITAL_PER_TRADE*100}% allowed`,
        balance, originalQty: signal.qty, suggestedQty: 0,
      };
    }

    return {
      approved: true,
      adjusted: true,
      reason: "QTY_REDUCED_EXPOSURE_LIMIT",
      message: `Qty reduced from ${signal.qty} to ${maxAffordableQty} to stay under 30% per-trade limit`,
      balance, originalQty: signal.qty, suggestedQty: maxAffordableQty,
      newMarginNeeded: maxAffordableQty * (isIntraday ? signal.entry / CONFIG.MIS_LEVERAGE : signal.entry),
    };
  }

  // ═══ CHECK 3: Total exposure (80%) ═══
  if (newExposurePct > CONFIG.MAX_TOTAL_EXPOSURE) {
    return {
      approved: false,
      reason: "EXCEEDS_TOTAL_EXPOSURE",
      message: `Would push exposure to ${(newExposurePct*100).toFixed(0)}% · max ${CONFIG.MAX_TOTAL_EXPOSURE*100}% allowed`,
      balance, originalQty: signal.qty, suggestedQty: 0,
    };
  }

  // ═══ APPROVED AS-IS ═══
  return {
    approved: true,
    adjusted: false,
    reason: "OK",
    message: `Balance check passed · using ${((marginNeeded/available)*100).toFixed(0)}% of available cash`,
    balance, originalQty: signal.qty, suggestedQty: signal.qty,
    marginNeeded, availableAfter: available - marginNeeded,
    exposurePctAfter: (newExposurePct * 100).toFixed(0),
  };
}

// ═══ QUICK HEALTH CHECK ════════════════════════════════════════════════════
export async function balanceHealth(jwtToken, apiKey) {
  const b = await fetchLiveBalance(jwtToken, apiKey);
  const available = b.availableCash || 0;
  const utilised = b.utilisedMargin || 0;
  const total = available + utilised;
  const exposurePct = total > 0 ? (utilised / total) * 100 : 0;

  let status = "HEALTHY", color = "green", msg = "Balance healthy, free to trade";
  if (available < CONFIG.MIN_CASH_BUFFER) {
    status = "CRITICAL"; color = "red"; msg = "Below buffer · no new trades";
  } else if (exposurePct > 75) {
    status = "HIGH_EXPOSURE"; color = "orange"; msg = "High exposure · close some positions";
  } else if (available < 10000) {
    status = "LOW_CASH"; color = "yellow"; msg = "Low cash · small trades only";
  }

  return {
    status, color, message: msg,
    available, utilised, total,
    exposurePct: parseFloat(exposurePct.toFixed(1)),
    buffer: CONFIG.MIN_CASH_BUFFER,
    canTrade: available > CONFIG.MIN_CASH_BUFFER,
    maxTradesAvailable: Math.floor((available - CONFIG.MIN_CASH_BUFFER) * CONFIG.MAX_CAPITAL_PER_TRADE / 1000) || 0,
  };
}

// ═══ API ENDPOINTS ═════════════════════════════════════════════════════════
export function addBalanceEndpoints(app, state, auth) {
  app.get("/api/balance/health", auth, async (req, res) => {
    const health = await balanceHealth(state.angelAuth, process.env.ANGEL_API_KEY);
    res.json(health);
  });

  app.get("/api/balance/live", auth, async (req, res) => {
    const balance = await fetchLiveBalance(state.angelAuth, process.env.ANGEL_API_KEY, true);
    res.json(balance);
  });

  app.post("/api/balance/check", auth, async (req, res) => {
    const { symbol, qty, entry, orderType } = req.body;
    const check = await smartBalanceCheck(
      { symbol, qty, entry, orderType },
      state.angelAuth,
      process.env.ANGEL_API_KEY
    );
    res.json(check);
  });
}
