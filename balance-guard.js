// ═══════════════════════════════════════════════════════════════════════════
// NSE TradeAI · Balance-Aware Trading Logic
// Ensures bot only trades with available balance, with safety buffer
// ═══════════════════════════════════════════════════════════════════════════

import { fetchBalance, fetchPositions } from "./angel-account-api.js";

// ─── SAFETY CONFIG ──────────────────────────────────────────────────────────
export const BALANCE_CONFIG = {
  MIN_CASH_BUFFER:        5000,     // Never use last ₹5,000 (emergency reserve)
  MAX_CAPITAL_PER_TRADE:  0.30,     // Max 30% of available cash per trade
  MAX_TOTAL_EXPOSURE:     0.80,     // Never deploy more than 80% of total capital
  REFRESH_BALANCE_MS:     60000,    // Refresh balance every 60s from Angel One
};

// ─── CACHED BALANCE ─────────────────────────────────────────────────────────
let cachedBalance = null;
let lastBalanceFetch = 0;

// ═══════════════════════════════════════════════════════════════════════════
// 1. GET LIVE BALANCE (with caching)
// ═══════════════════════════════════════════════════════════════════════════
export async function getLiveBalance(jwtToken, apiKey, forceFresh = false) {
  const now = Date.now();
  const cacheAge = now - lastBalanceFetch;

  if (!forceFresh && cachedBalance && cacheAge < BALANCE_CONFIG.REFRESH_BALANCE_MS) {
    return cachedBalance;
  }

  try {
    const balance = await fetchBalance(jwtToken, apiKey);
    cachedBalance = balance;
    lastBalanceFetch = now;
    return balance;
  } catch (e) {
    console.error("getLiveBalance error:", e.message);
    return cachedBalance || {
      availableCash: 0,
      utilisedMargin: 0,
      error: e.message
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. PRE-TRADE BALANCE CHECK — call BEFORE placing any order
// ═══════════════════════════════════════════════════════════════════════════
export async function preTradeBalanceCheck(signal, jwtToken, apiKey) {
  const balance = await getLiveBalance(jwtToken, apiKey, true);  // force fresh
  
  const available = balance.availableCash || 0;
  const utilised = balance.utilisedMargin || 0;
  const totalCapital = available + utilised;
  
  // Calculate required capital for the trade
  const requiredCapital = signal.qty * signal.entry;
  
  // For INTRADAY, Angel gives ~5x leverage, so only need 20% as margin
  const actualMarginNeeded = signal.orderType === "INTRADAY" 
    ? requiredCapital * 0.20 
    : requiredCapital;  // Full amount for CNC delivery
  
  // ═══ CHECK 1: Basic availability ═══
  const availableAfterBuffer = available - BALANCE_CONFIG.MIN_CASH_BUFFER;
  if (availableAfterBuffer < actualMarginNeeded) {
    return {
      approved: false,
      reason: "INSUFFICIENT_FUNDS",
      message: `Need ₹${actualMarginNeeded.toFixed(0)} but only ₹${availableAfterBuffer.toFixed(0)} available (after ₹${BALANCE_CONFIG.MIN_CASH_BUFFER} safety buffer)`,
      balance,
      suggestedQty: 0,
    };
  }
  
  // ═══ CHECK 2: Max 30% of available cash per trade ═══
  const maxCapitalPerTrade = available * BALANCE_CONFIG.MAX_CAPITAL_PER_TRADE;
  if (actualMarginNeeded > maxCapitalPerTrade) {
    // Suggest reduced quantity that fits the 30% rule
    const suggestedCapital = maxCapitalPerTrade;
    const suggestedQty = signal.orderType === "INTRADAY"
      ? Math.floor(suggestedCapital / (signal.entry * 0.20))
      : Math.floor(suggestedCapital / signal.entry);
    
    return {
      approved: false,
      reason: "EXCEEDS_PER_TRADE_LIMIT",
      message: `Trade would use ${((actualMarginNeeded/available)*100).toFixed(0)}% of cash. Max ${(BALANCE_CONFIG.MAX_CAPITAL_PER_TRADE*100).toFixed(0)}% allowed per trade.`,
      balance,
      suggestedQty: Math.min(suggestedQty, signal.qty),  // cap at original qty
    };
  }
  
  // ═══ CHECK 3: Total exposure limit (80% max) ═══
  const newTotalExposure = (utilised + actualMarginNeeded) / totalCapital;
  if (newTotalExposure > BALANCE_CONFIG.MAX_TOTAL_EXPOSURE) {
    return {
      approved: false,
      reason: "EXCEEDS_TOTAL_EXPOSURE",
      message: `Would push total exposure to ${(newTotalExposure*100).toFixed(0)}%. Max ${(BALANCE_CONFIG.MAX_TOTAL_EXPOSURE*100).toFixed(0)}% allowed.`,
      balance,
      suggestedQty: 0,
    };
  }
  
  // ═══ APPROVED ═══
  return {
    approved: true,
    reason: "OK",
    message: "Balance check passed",
    balance,
    actualMarginNeeded,
    availableAfter: available - actualMarginNeeded,
    exposurePct: (newTotalExposure * 100).toFixed(0),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. DYNAMIC POSITION SIZING — adjusts qty based on current balance
// ═══════════════════════════════════════════════════════════════════════════
export async function calculateSafeQty(price, riskAmount, jwtToken, apiKey, orderType = "INTRADAY") {
  const balance = await getLiveBalance(jwtToken, apiKey);
  const available = balance.availableCash || 0;
  
  // Stop-loss distance (1.5% of entry price)
  const stopDist = price * 0.015;
  
  // Base qty from risk amount (your ₹1,000 risk rule)
  const riskBasedQty = Math.floor(riskAmount / stopDist);
  
  // Capital required for this qty
  const capitalForTrade = orderType === "INTRADAY"
    ? (riskBasedQty * price * 0.20)  // 5x leverage = 20% margin
    : (riskBasedQty * price);
  
  // Max capital we're willing to deploy (30% of available)
  const maxCapital = (available - BALANCE_CONFIG.MIN_CASH_BUFFER) * BALANCE_CONFIG.MAX_CAPITAL_PER_TRADE;
  
  // If risk-based qty needs more capital than we can deploy, reduce qty
  if (capitalForTrade > maxCapital) {
    const reducedQty = orderType === "INTRADAY"
      ? Math.floor(maxCapital / (price * 0.20))
      : Math.floor(maxCapital / price);
    
    return {
      qty: reducedQty,
      capital: reducedQty * price,
      marginNeeded: reducedQty * price * (orderType === "INTRADAY" ? 0.20 : 1),
      actualRisk: reducedQty * stopDist,
      reduced: true,
      reason: `Qty reduced from ${riskBasedQty} to ${reducedQty} due to balance constraint`,
    };
  }
  
  return {
    qty: riskBasedQty,
    capital: riskBasedQty * price,
    marginNeeded: capitalForTrade,
    actualRisk: riskBasedQty * stopDist,
    reduced: false,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. BALANCE HEALTH CHECK
// ═══════════════════════════════════════════════════════════════════════════
export async function getBalanceHealth(jwtToken, apiKey) {
  const balance = await getLiveBalance(jwtToken, apiKey);
  const available = balance.availableCash || 0;
  const utilised = balance.utilisedMargin || 0;
  const total = available + utilised;
  const exposurePct = total > 0 ? (utilised / total) * 100 : 0;
  
  let status = "HEALTHY";
  let statusColor = "green";
  let message = "Balance healthy, can trade freely";
  
  if (available < BALANCE_CONFIG.MIN_CASH_BUFFER) {
    status = "CRITICAL";
    statusColor = "red";
    message = "Cash below safety buffer. No new trades allowed.";
  } else if (exposurePct > 70) {
    status = "WARNING";
    statusColor = "orange";
    message = "High exposure. Consider closing some positions.";
  } else if (available < 10000) {
    status = "LOW";
    statusColor = "yellow";
    message = "Cash low. Small trades only.";
  }
  
  return {
    status,
    statusColor,
    message,
    available,
    utilised,
    total,
    exposurePct: parseFloat(exposurePct.toFixed(1)),
    buffer: BALANCE_CONFIG.MIN_CASH_BUFFER,
    canTrade: available > BALANCE_CONFIG.MIN_CASH_BUFFER,
  };
}
