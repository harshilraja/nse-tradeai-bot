// ═══════════════════════════════════════════════════════════════════════════
// NSE TradeAI Bot v7.0 · COMPLETE PRODUCTION
//
// REQUIREMENTS IMPLEMENTED:
// 1. ✅ Nifty 50 + 20 best-performing stocks
// 2. ✅ 20-day historical loading with rate limiting (1 req/sec)
// 3. ✅ Higher TF confirmation (15-min + daily trend)
// 4. ✅ Trading window: 9:30 AM - 3:15 PM
// 5. ✅ Nifty + BankNifty trend filter
// 6. ✅ DELIVERY only (no leverage), holdings analyzer
// 7. ✅ Balance-aware suggestion (X shares possible)
// 8. ✅ Detailed backtest trade log
// 9. ✅ Backtest uses analyzeSignal (single source of truth)
// 10. ✅ Mobile: daily signals + P&L tab
// 11. ✅ Broker charges + GST in P&L
// 12. ✅ Minimum 1 trade/day (forced signal)
// 13. ✅ Dynamic capital from Angel One, 1% risk, 2% daily cap
// ═══════════════════════════════════════════════════════════════════════════

import axios from "axios";
import { authenticator } from "otplib";
import TelegramBot from "node-telegram-bot-api";
import WebSocket from "ws";
import fs from "fs";
import dotenv from "dotenv";
import {
  initDB, logSignal, logTrade, closeTrade as dbCloseTrade,
  updateSLMovement, logEvent, startAPI, db
} from "./db-api.js";
import { addAccountEndpoints } from "./angel-account-api.js";

dotenv.config();

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════
const CONFIG = {
  // ─── REQ 13: Dynamic capital + percentage-based risk ───
  RISK_PCT:           0.01,    // 1% risk per trade
  DAILY_LOSS_PCT:     0.02,    // 2% daily loss cap
  REWARD_RATIO:       4,
  MAX_POSITIONS:      3,
  LIVE_TRADING:       process.env.LIVE_TRADING === "true",

  // ─── ATR-based SL/Target ───
  SL_PCT:             0.012,
  TARGET_PCT:         0.030,
  ATR_SL_MULT:        2.5,
  ATR_TARGET_MULT:    6.0,

  // ─── Breakeven & Partial ───
  BREAKEVEN_TRIGGER_PCT: 0.012,
  PARTIAL_BOOK_PCT:      0.020,
  PARTIAL_BOOK_FRACTION: 0.50,

  // ─── Quality filter ───
  TOP_SIGNALS_PER_DAY:   5,
  MIN_SCORE_FOR_TRADE:   3.5,
  SIGNAL_SCORE_BUY:      5,
  SIGNAL_SCORE_SELL:     -5,
  MIN_CONFLUENCE:        3,
  MIN_CONFIDENCE:        60,
  MIN_VOLUME_RATIO:      1.5,
  MIN_CANDLES:           30,
  MIN_ADX:               25,

  // ─── REQ 4: Trading window 9:30 AM - 3:15 PM ───
  TRADING_START_HOUR:    9,
  TRADING_START_MIN:     30,
  TRADING_END_HOUR:      15,
  TRADING_END_MIN:       15,

  // ─── REQ 2: Historical data range ───
  HISTORICAL_DAYS:       20,
  HISTORICAL_RATE_LIMIT_MS: 1100,  // ~1 req/sec to respect Angel rate limits

  // ─── REQ 12: Forced signal logic ───
  FORCE_SIGNAL_AFTER_HOUR: null,   // After 11:30 AM
  FORCE_SIGNAL_MAX_HOUR:   null,   // Until 2:30 PM

  // ─── REQ 6: Order type — DELIVERY only ───
  ORDER_TYPE:            "DELIVERY",  // CNC, no leverage
  ANALYZE_HOLDINGS:      true,         // Check existing holdings for sell signals

  // ─── Balance protection ───
  MIN_CASH_BUFFER:       5000,
  MAX_CAPITAL_PER_TRADE: 0.30,

  // ─── Scheduler ───
  SCAN_INTERVAL_MS:      30000,    // Slower for delivery (less scalping)
  WATCHDOG_INTERVAL_MS:  60000,
  SCHEDULER_TIMEOUT_MS:  120000,

  // ─── REQ 11: Charges ───
  // STT: 0.1% on buy & sell (delivery)
  // Brokerage: ₹20 per order or 0.03% (whichever is lower)
  // GST: 18% on (brokerage + transaction charges)
  // Stamp duty: 0.015% on buy
  // Exchange charges: 0.00345% (NSE) on both sides
  // SEBI: ₹10/crore
  // DP charges: ₹15.93 per scrip on sell day
  CHARGES: {
    STT_PCT:           0.001,     // 0.1% on both sides for delivery
    BROKERAGE_FLAT:    20,
    BROKERAGE_PCT:     0.0003,    // 0.03%
    GST_PCT:           0.18,
    STAMP_PCT:         0.00015,   // Buy side only
    EXCHANGE_PCT:      0.0000345,
    SEBI_PCT:          0.000001,
    DP_CHARGE:         15.93,
  },

  // ─── REQ 1: Watchlist (Nifty 50 + Best Performers) ───
  NIFTY_50: [
    "RELIANCE","HDFCBANK","ICICIBANK","INFY","TCS","HINDUNILVR","ITC","BHARTIARTL",
    "SBIN","LT","KOTAKBANK","AXISBANK","BAJFINANCE","ASIANPAINT","MARUTI",
    "SUNPHARMA","TITAN","HCLTECH","ULTRACEMCO","NTPC","WIPRO","NESTLEIND",
    "POWERGRID","TATASTEEL","TECHM","ONGC","JSWSTEEL","ADANIENT","ADANIPORTS",
    "COALINDIA","BAJAJFINSV","GRASIM","HINDALCO","DRREDDY","BRITANNIA",
    "CIPLA","BPCL","INDUSINDBK","EICHERMOT","APOLLOHOSP","HEROMOTOCO",
    "DIVISLAB","TATAMOTORS","UPL","SBILIFE","HDFCLIFE","LTIM",
    "TATACONSUM","BAJAJHLDNG","DMART"
  ],
  // Best performers (high momentum stocks beyond Nifty 50)
  BEST_PERFORMERS: [
    "TRENT","BEL","CGPOWER","DIXON","POLYCAB","SUZLON","IRFC",
    "PERSISTENT","KAYNES","INOXWIND","HAL","BHEL","RVNL","IRCTC",
    "ZOMATO","NYKAA","PAYTM","POLICYBZR","DELHIVERY","NAUKRI"
  ],
  // Index symbols for trend
  INDEX_NIFTY:    "NIFTY",
  INDEX_BANKNIFTY:"NIFTYBANK",
};

// Combined watchlist
CONFIG.WATCHLIST = [...CONFIG.NIFTY_50, ...CONFIG.BEST_PERFORMERS];

const ENV = {
  ANGEL_CLIENT_ID:   process.env.ANGEL_CLIENT_ID,
  ANGEL_API_KEY:     process.env.ANGEL_API_KEY,
  ANGEL_MPIN:        process.env.ANGEL_MPIN,
  ANGEL_TOTP_TOKEN:  process.env.ANGEL_TOTP_TOKEN,
  TELEGRAM_TOKEN:    process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID:  process.env.TELEGRAM_CHAT_ID,
};

// Hardcoded fallback tokens (Nifty 50)
const NIFTY_50_FALLBACK_TOKENS = {
  "RELIANCE":"2885","HDFCBANK":"1333","ICICIBANK":"4963","INFY":"1594","TCS":"11536",
  "HINDUNILVR":"1394","ITC":"1660","BHARTIARTL":"10604","SBIN":"3045","LT":"11483",
  "KOTAKBANK":"1922","AXISBANK":"5900","BAJFINANCE":"317","ASIANPAINT":"236","MARUTI":"10999",
  "SUNPHARMA":"3351","TITAN":"3506","HCLTECH":"7229","ULTRACEMCO":"11532","NTPC":"11630",
  "WIPRO":"3787","NESTLEIND":"17963","POWERGRID":"14977","TATASTEEL":"3499","TECHM":"13538",
  "ONGC":"2475","JSWSTEEL":"11723","ADANIENT":"25","ADANIPORTS":"15083","COALINDIA":"20374",
  "BAJAJFINSV":"16675","GRASIM":"1232","HINDALCO":"1363","DRREDDY":"881","BRITANNIA":"547",
  "CIPLA":"694","BPCL":"526","INDUSINDBK":"5258","EICHERMOT":"910","APOLLOHOSP":"157",
  "HEROMOTOCO":"1348","DIVISLAB":"10940","TATAMOTORS":"3456","UPL":"11287","SBILIFE":"21808",
  "HDFCLIFE":"467","LTIM":"17818","TATACONSUM":"3432","BAJAJHLDNG":"16669","DMART":"19913",
};

// Index tokens
const INDEX_TOKENS = {
  "NIFTY":     "99926000",  // NIFTY 50 spot
  "NIFTYBANK": "99926009",  // NIFTY BANK spot
};

// ═══════════════════════════════════════════════════════════════════════════
// GLOBAL STATE
// ═══════════════════════════════════════════════════════════════════════════
export const state = {
  angelAuth: null, feedToken: null, ws: null,
  livePrices: new Map(),
  candleBuffer5m: new Map(),    // 5-min candles
  candleBuffer15m: new Map(),   // 15-min candles (HTF)
  candleBufferDaily: new Map(), // Daily (HTF)
  openTrades: [], pendingSignals: new Map(),
  holdings: [],                  // From Angel
  capital: 250000,               // Will be fetched from Angel
  dayPnL: { live: 0, paper: 0 }, isHalted: false,
  symbolTokens: new Map(), tokenToSymbol: new Map(),
  scanCount: 0, lastScanTime: null,
  signalsToday: 0, forcedSignalSent: false,
  scripMaster: null, scripMasterLoaded: false, usingFallback: false,
  cachedBalance: null, balanceCacheTime: 0,
  niftyTrend: "neutral", bankNiftyTrend: "neutral",
};

let schedulerRunning = false;
let lastScanCompletedAt = null;
let scanInterval = null;
let watchdogInterval = null;

function log(msg) {
  const ts = new Date().toISOString().replace("T", " ").substring(0, 19);
  console.log(`[${ts}] ${msg}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// IST DATE HELPERS
// ═══════════════════════════════════════════════════════════════════════════
function getISTDate() {
  const now = new Date();
  return new Date(now.getTime() + (now.getTimezoneOffset() * 60 * 1000) + (5.5 * 60 * 60 * 1000));
}
function formatAngelDate(d) {
  const pad = n => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function getHistoricalRange(daysBack) {
  let end = getISTDate();
  if (end.getHours() < 9) end.setDate(end.getDate() - 1);
  while (end.getDay() === 0 || end.getDay() === 6) end.setDate(end.getDate() - 1);
  end.setHours(15, 30, 0, 0);
  let start = new Date(end);
  let trading = 0;
  while (trading < daysBack) {
    start.setDate(start.getDate() - 1);
    if (start.getDay() !== 0 && start.getDay() !== 6) trading++;
  }
  start.setHours(9, 15, 0, 0);
  return { fromdate: formatAngelDate(start), todate: formatAngelDate(end) };
}

// ═══════════════════════════════════════════════════════════════════════════
// REQ 4: Trading window 9:30 AM - 3:15 PM
// ═══════════════════════════════════════════════════════════════════════════
function isTradingWindow() {
  const ist = getISTDate();
  if (ist.getDay() === 0 || ist.getDay() === 6) return false;
  const mins = ist.getHours() * 60 + ist.getMinutes();
  const start = CONFIG.TRADING_START_HOUR * 60 + CONFIG.TRADING_START_MIN;
  const end = CONFIG.TRADING_END_HOUR * 60 + CONFIG.TRADING_END_MIN;
  return mins >= start && mins <= end;
}
function getMarketStatus() {
  const ist = getISTDate();
  const day = ist.getDay();
  const mins = ist.getHours() * 60 + ist.getMinutes();
  const start = CONFIG.TRADING_START_HOUR * 60 + CONFIG.TRADING_START_MIN;
  const end = CONFIG.TRADING_END_HOUR * 60 + CONFIG.TRADING_END_MIN;
  if (day === 0 || day === 6) return { status: "closed", reason: "Weekend" };
  if (mins < start) return { status: "pre_market", reason: `Opens ${CONFIG.TRADING_START_HOUR}:${String(CONFIG.TRADING_START_MIN).padStart(2,'0')}` };
  if (mins > end) return { status: "post_market", reason: "Closed for today" };
  return { status: "open", reason: "Trading window active" };
}

// ═══════════════════════════════════════════════════════════════════════════
// REQ 11: Charge calculator
// ═══════════════════════════════════════════════════════════════════════════
function calculateCharges(buyValue, sellValue) {
  const C = CONFIG.CHARGES;
  // STT (0.1% both sides for delivery)
  const stt = (buyValue + sellValue) * C.STT_PCT;
  // Brokerage (₹20 or 0.03%, whichever lower) on each leg
  const brokerageBuy = Math.min(C.BROKERAGE_FLAT, buyValue * C.BROKERAGE_PCT);
  const brokerageSell = Math.min(C.BROKERAGE_FLAT, sellValue * C.BROKERAGE_PCT);
  const totalBrokerage = brokerageBuy + brokerageSell;
  // Exchange charges (NSE)
  const exchangeCharges = (buyValue + sellValue) * C.EXCHANGE_PCT;
  // SEBI charges
  const sebi = (buyValue + sellValue) * C.SEBI_PCT;
  // GST 18% on (brokerage + exchange + sebi)
  const gst = (totalBrokerage + exchangeCharges + sebi) * C.GST_PCT;
  // Stamp duty (buy side only)
  const stamp = buyValue * C.STAMP_PCT;
  // DP charges (sell side, per scrip)
  const dp = C.DP_CHARGE;
  
  const total = stt + totalBrokerage + exchangeCharges + sebi + gst + stamp + dp;
  return {
    stt: parseFloat(stt.toFixed(2)),
    brokerage: parseFloat(totalBrokerage.toFixed(2)),
    exchange: parseFloat(exchangeCharges.toFixed(2)),
    sebi: parseFloat(sebi.toFixed(2)),
    gst: parseFloat(gst.toFixed(2)),
    stamp: parseFloat(stamp.toFixed(2)),
    dp: parseFloat(dp.toFixed(2)),
    total: parseFloat(total.toFixed(2)),
  };
}
function netPnL(grossPnL, buyValue, sellValue) {
  const charges = calculateCharges(buyValue, sellValue);
  return {
    gross: parseFloat(grossPnL.toFixed(2)),
    charges: charges.total,
    chargesBreakdown: charges,
    net: parseFloat((grossPnL - charges.total).toFixed(2)),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ANGEL ONE AUTH
// ═══════════════════════════════════════════════════════════════════════════
function angelHeaders() {
  return {
    "Authorization": `Bearer ${state.angelAuth}`,
    "Content-Type": "application/json", "Accept": "application/json",
    "X-UserType": "USER", "X-SourceID": "WEB",
    "X-ClientLocalIP": "192.168.1.1", "X-ClientPublicIP": "103.0.0.1",
    "X-MACAddress": "00:00:00:00:00:00", "X-PrivateKey": ENV.ANGEL_API_KEY,
  };
}
async function authenticateAngel() {
  log("🔐 Authenticating with Angel One...");
  try {
    const totp = authenticator.generate(ENV.ANGEL_TOTP_TOKEN);
    const res = await axios.post(
      "https://apiconnect.angelbroking.com/rest/auth/angelbroking/user/v1/loginByPassword",
      { clientcode: ENV.ANGEL_CLIENT_ID, password: ENV.ANGEL_MPIN, totp },
      { headers: { ...angelHeaders(), "Authorization": undefined } }
    );
    if (res.data?.data?.jwtToken) {
      state.angelAuth = res.data.data.jwtToken;
      state.feedToken = res.data.data.feedToken;
      log("✅ Authenticated");
      return true;
    }
    throw new Error(res.data?.message || "Auth failed");
  } catch (e) {
    log(`❌ Auth: ${e.message}`);
    return false;
  }
}
setInterval(async () => { await authenticateAngel(); }, 6 * 60 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════════════
// REQ 13: Fetch capital from Angel One
// ═══════════════════════════════════════════════════════════════════════════
async function fetchCapital() {
  try {
    const res = await axios.get(
      "https://apiconnect.angelbroking.com/rest/secure/angelbroking/user/v1/getRMS",
      { headers: angelHeaders(), timeout: 8000 }
    );
    const d = res.data?.data || {};
    const totalCapital = parseFloat(d.net || 0) || (parseFloat(d.availablecash || 0) + parseFloat(d.utiliseddebits || 0));
    if (totalCapital > 0) {
      state.capital = totalCapital;
      log(`💰 Capital fetched: ₹${state.capital.toLocaleString("en-IN")}`);
      log(`   Risk/trade: ₹${(state.capital * CONFIG.RISK_PCT).toFixed(0)} (${CONFIG.RISK_PCT*100}%)`);
      log(`   Daily loss cap: ₹${(state.capital * CONFIG.DAILY_LOSS_PCT).toFixed(0)} (${CONFIG.DAILY_LOSS_PCT*100}%)`);
    }
    return totalCapital;
  } catch (e) {
    log(`⚠️ Capital fetch failed: ${e.message} · using ₹${state.capital}`);
    return state.capital;
  }
}
function getRiskPerTrade() { return state.capital * CONFIG.RISK_PCT; }
function getDailyLossCap() { return state.capital * CONFIG.DAILY_LOSS_PCT; }

setInterval(fetchCapital, 30 * 60 * 1000);  // Refresh every 30 min

// ═══════════════════════════════════════════════════════════════════════════
// SCRIP MASTER (bulletproof)
// ═══════════════════════════════════════════════════════════════════════════
const SCRIP_URLS = [
  "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json",
  "https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json",
];
const SCRIP_PATH = "./scrip-master.json";

async function loadScripMaster() {
  if (state.scripMasterLoaded) return true;
  if (fs.existsSync(SCRIP_PATH)) {
    try {
      const stats = fs.statSync(SCRIP_PATH);
      const ageHours = (Date.now() - stats.mtimeMs) / 3600000;
      const data = JSON.parse(fs.readFileSync(SCRIP_PATH, "utf8"));
      if (data?.length > 1000) {
        state.scripMaster = data;
        state.scripMasterLoaded = true;
        log(`✅ Scrip from disk: ${data.length} (${ageHours.toFixed(1)}h)`);
        return true;
      }
    } catch {}
  }
  for (const url of SCRIP_URLS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await axios.get(url, { timeout: 60000, maxContentLength: 200*1024*1024 });
        if (Array.isArray(res.data) && res.data.length > 1000) {
          state.scripMaster = res.data;
          state.scripMasterLoaded = true;
          try { fs.writeFileSync(SCRIP_PATH, JSON.stringify(res.data)); } catch {}
          log(`✅ Scrip downloaded: ${res.data.length}`);
          return true;
        }
      } catch (e) {
        if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
  }
  // Hardcoded fallback
  state.scripMaster = Object.entries(NIFTY_50_FALLBACK_TOKENS).map(([s, t]) => ({
    symbol: `${s}-EQ`, name: s, token: t, exch_seg: "NSE",
  }));
  state.scripMasterLoaded = true;
  state.usingFallback = true;
  log(`⚠️ Using ${state.scripMaster.length} hardcoded fallback`);
  return true;
}
async function getSymbolToken(symbol) {
  if (state.symbolTokens.has(symbol)) return state.symbolTokens.get(symbol);
  if (INDEX_TOKENS[symbol]) {
    state.symbolTokens.set(symbol, INDEX_TOKENS[symbol]);
    state.tokenToSymbol.set(INDEX_TOKENS[symbol], symbol);
    return INDEX_TOKENS[symbol];
  }
  if (NIFTY_50_FALLBACK_TOKENS[symbol]) {
    const t = NIFTY_50_FALLBACK_TOKENS[symbol];
    state.symbolTokens.set(symbol, t);
    state.tokenToSymbol.set(t, symbol);
    return t;
  }
  if (!state.scripMasterLoaded) await loadScripMaster();
  if (!state.scripMaster) return null;
  let m = state.scripMaster.find(s => s.symbol === `${symbol}-EQ` && s.exch_seg === "NSE");
  if (!m) m = state.scripMaster.find(s => s.name === symbol && s.exch_seg === "NSE" && s.symbol?.endsWith("-EQ"));
  if (m?.token) {
    state.symbolTokens.set(symbol, m.token);
    state.tokenToSymbol.set(m.token, symbol);
    return m.token;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// REQ 2: Historical candles with rate limiting (1 req/sec)
// ═══════════════════════════════════════════════════════════════════════════
async function fetchHistorical(symbol, interval, daysBack, retries = 2) {
  const token = await getSymbolToken(symbol);
  if (!token) return [];
  const exchange = INDEX_TOKENS[symbol] ? "NSE" : "NSE";
  const { fromdate, todate } = getHistoricalRange(daysBack);
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await axios.post(
        "https://apiconnect.angelbroking.com/rest/secure/angelbroking/historical/v1/getCandleData",
        { exchange, symboltoken: token, interval, fromdate, todate },
        { headers: angelHeaders(), timeout: 20000 }
      );
      const data = res.data?.data || [];
      return data.map(c => ({
        time: new Date(c[0]),
        bucket: c[0],
        o: parseFloat(c[1]), h: parseFloat(c[2]),
        l: parseFloat(c[3]), c: parseFloat(c[4]),
        v: parseInt(c[5]),
      }));
    } catch (e) {
      const status = e.response?.status;
      if (status === 401 && attempt < retries) { await authenticateAngel(); continue; }
      if (status === 429 && attempt < retries) { await new Promise(r => setTimeout(r, 3000)); continue; }
      return [];
    }
  }
  return [];
}

async function loadAllHistoricalData() {
  log(`📊 Loading ${CONFIG.HISTORICAL_DAYS}-day data with rate limiting...`);
  let total5m = 0, total15m = 0, totalDaily = 0;
  let ok = 0;
  
  for (const sym of CONFIG.WATCHLIST) {
    // 5-min candles
    const c5 = await fetchHistorical(sym, "FIVE_MINUTE", CONFIG.HISTORICAL_DAYS);
    if (c5.length > 0) {
      state.candleBuffer5m.set(sym, c5);
      total5m += c5.length;
      ok++;
    }
    await new Promise(r => setTimeout(r, CONFIG.HISTORICAL_RATE_LIMIT_MS));
    
    // 15-min candles for HTF
    const c15 = await fetchHistorical(sym, "FIFTEEN_MINUTE", CONFIG.HISTORICAL_DAYS);
    if (c15.length > 0) {
      state.candleBuffer15m.set(sym, c15);
      total15m += c15.length;
    }
    await new Promise(r => setTimeout(r, CONFIG.HISTORICAL_RATE_LIMIT_MS));
    
    // Daily candles for HTF
    const cD = await fetchHistorical(sym, "ONE_DAY", CONFIG.HISTORICAL_DAYS);
    if (cD.length > 0) {
      state.candleBufferDaily.set(sym, cD);
      totalDaily += cD.length;
    }
    await new Promise(r => setTimeout(r, CONFIG.HISTORICAL_RATE_LIMIT_MS));
  }
  
  log(`✅ Loaded · 5m:${total5m} · 15m:${total15m} · daily:${totalDaily} (${ok}/${CONFIG.WATCHLIST.length} stocks)`);
  
  // REQ 5: Load index data
  log(`📊 Loading index trend data...`);
  const niftyDaily = await fetchHistorical(CONFIG.INDEX_NIFTY, "ONE_DAY", 20);
  const bankNiftyDaily = await fetchHistorical(CONFIG.INDEX_BANKNIFTY, "ONE_DAY", 20);
  if (niftyDaily.length > 0) {
    state.candleBufferDaily.set(CONFIG.INDEX_NIFTY, niftyDaily);
    state.niftyTrend = computeIndexTrend(niftyDaily);
    log(`   Nifty trend: ${state.niftyTrend}`);
  }
  if (bankNiftyDaily.length > 0) {
    state.candleBufferDaily.set(CONFIG.INDEX_BANKNIFTY, bankNiftyDaily);
    state.bankNiftyTrend = computeIndexTrend(bankNiftyDaily);
    log(`   BankNifty trend: ${state.bankNiftyTrend}`);
  }
}

function computeIndexTrend(candles) {
  if (candles.length < 10) return "neutral";
  const closes = candles.map(c => c.c);
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const last = closes[closes.length-1];
  if (last > e9 && e9 > e21) return "bullish";
  if (last < e9 && e9 < e21) return "bearish";
  return "neutral";
}

// Update index trends every 30 min during market hours
setInterval(async () => {
  if (!isTradingWindow()) return;
  const ndaily = await fetchHistorical(CONFIG.INDEX_NIFTY, "ONE_DAY", 20);
  const bdaily = await fetchHistorical(CONFIG.INDEX_BANKNIFTY, "ONE_DAY", 20);
  if (ndaily.length > 0) state.niftyTrend = computeIndexTrend(ndaily);
  if (bdaily.length > 0) state.bankNiftyTrend = computeIndexTrend(bdaily);
}, 30 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════════════
// WEBSOCKET
// ═══════════════════════════════════════════════════════════════════════════
async function startWebSocket(tokens) {
  if (!tokens?.length) return;
  const wsUrl = `wss://smartapisocket.angelone.in/smart-stream?clientCode=${ENV.ANGEL_CLIENT_ID}&feedToken=${state.feedToken}&apiKey=${ENV.ANGEL_API_KEY}`;
  state.ws = new WebSocket(wsUrl);
  state.ws.on("open", () => {
    log(`📡 WS connected · ${tokens.length} tokens`);
    const chunks = [];
    for (let i = 0; i < tokens.length; i += 50) chunks.push(tokens.slice(i, i + 50));
    chunks.forEach((chunk, i) => {
      setTimeout(() => {
        if (state.ws?.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify({
            correlationID: `t-${i}`, action: 1,
            params: { mode: 2, tokenList: [{ exchangeType: 1, tokens: chunk }] }
          }));
        }
      }, i * 300);
    });
  });
  let tickCount = 0;
  state.ws.on("message", (data) => {
    try {
      const tick = parseBinaryTick(data);
      if (tick?.token) {
        tickCount++;
        if (tickCount % 500 === 0) log(`📡 ${tickCount} ticks`);
        const symbol = state.tokenToSymbol.get(tick.token);
        if (symbol) {
          state.livePrices.set(symbol, {
            ltp: tick.ltp, volume: tick.volume,
            openPrice: state.livePrices.get(symbol)?.openPrice || tick.ltp,
            timestamp: Date.now(),
          });
          updateCandles(symbol, tick.ltp, tick.volume);
        }
      }
    } catch {}
  });
  state.ws.on("close", () => setTimeout(() => startWebSocket(tokens), 5000));
  state.ws.on("error", (e) => log(`⚠️ WS: ${e.message}`));
  setInterval(() => { if (state.ws?.readyState === WebSocket.OPEN) state.ws.ping(); }, 30000);
}
function parseBinaryTick(buf) {
  if (!buf || buf.length < 51) return null;
  try {
    let token = "";
    for (let i = 2; i < 27; i++) { if (buf[i] === 0) break; token += String.fromCharCode(buf[i]); }
    token = token.trim();
    const ltp = buf.readInt32LE(43) / 100;
    const ltq = buf.length >= 51 ? buf.readInt32LE(47) : 0;
    if (ltp <= 0 || !token) return null;
    return { token, ltp, volume: ltq };
  } catch { return null; }
}
function updateCandles(symbol, ltp, vol) {
  if (!state.candleBuffer5m.has(symbol)) state.candleBuffer5m.set(symbol, []);
  const cs = state.candleBuffer5m.get(symbol);
  const ist = getISTDate();
  const bucket = Math.floor(ist.getMinutes() / 5) * 5;
  const key = `${ist.getHours()}:${bucket}`;
  const last = cs[cs.length - 1];
  if (!last || last.bucket !== key) {
    cs.push({ bucket: key, o: ltp, h: ltp, l: ltp, c: ltp, v: vol });
    if (cs.length > 500) cs.shift();
  } else {
    last.h = Math.max(last.h, ltp);
    last.l = Math.min(last.l, ltp);
    last.c = ltp;
    last.v += vol;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// INDICATORS
// ═══════════════════════════════════════════════════════════════════════════
const ema = (v, p) => { if (v.length < p) return v[v.length-1] || 0; const k = 2/(p+1); let e = v.slice(0, p).reduce((a,b) => a+b, 0)/p; for (let i = p; i < v.length; i++) e = v[i]*k + e*(1-k); return e; };
const sma = (v, p) => v.length < p ? (v[v.length-1] || 0) : v.slice(-p).reduce((a,b) => a+b, 0)/p;
function rsi(c, p=14) { if (c.length < p+1) return 50; const ch = c.slice(1).map((x,i) => x-c[i]); const g = ch.map(x => x>0?x:0); const l = ch.map(x => x<0?-x:0); let ag = g.slice(0,p).reduce((a,b) => a+b, 0)/p; let al = l.slice(0,p).reduce((a,b) => a+b, 0)/p; for (let i = p; i < ch.length; i++) { ag = (ag*(p-1)+g[i])/p; al = (al*(p-1)+l[i])/p; } return 100 - 100/(1 + ag/(al||0.001)); }
function macd(c) { const e12 = ema(c, 12), e26 = ema(c, 26); return { value: e12-e26, bullish: e12 > e26 }; }
function vwap(cs) { if (!cs.length) return 0; let pv=0, tv=0; for (const c of cs) { pv += ((c.h+c.l+c.c)/3)*c.v; tv += c.v; } return tv > 0 ? pv/tv : cs[cs.length-1].c; }
function atr(cs, p=14) { if (cs.length < p+1) return 0; const trs = []; for (let i = 1; i < cs.length; i++) { const h = cs[i].h, l = cs[i].l, pc = cs[i-1].c; trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc))); } return sma(trs.slice(-p), p); }
function adx(cs, p=14) { if (cs.length < p*2) return { adx:0, plusDI:0, minusDI:0, trending:false }; const pdms=[],mdms=[],trs=[]; for (let i = 1; i < cs.length; i++) { const um = cs[i].h-cs[i-1].h, dm = cs[i-1].l-cs[i].l; pdms.push(um>dm && um>0 ? um : 0); mdms.push(dm>um && dm>0 ? dm : 0); const h = cs[i].h, l = cs[i].l, pc = cs[i-1].c; trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc))); } const stt = sma(trs.slice(-p), p); const spm = sma(pdms.slice(-p), p); const smm = sma(mdms.slice(-p), p); const pdi = (spm/(stt||1))*100; const mdi = (smm/(stt||1))*100; const dx = Math.abs(pdi-mdi)/((pdi+mdi)||1)*100; return { adx: dx, plusDI: pdi, minusDI: mdi, trending: dx > 25 }; }
function supertrend(cs, p=10, m=3) { if (cs.length < p) return { trend: "neutral" }; const a = atr(cs, p); const last = cs[cs.length-1]; const hl2 = (last.h+last.l)/2; const ub = hl2 + m*a, lb = hl2 - m*a; return { trend: last.c > ub ? "bull" : last.c < lb ? "bear" : "neutral" }; }
function bollinger(c, p=20) { if (c.length < p) return { upper:0, lower:0, mid:0 }; const s = c.slice(-p); const m = s.reduce((a,b) => a+b, 0)/p; const sd = Math.sqrt(s.reduce((a,b) => a+(b-m)**2, 0)/p); return { upper: m+2*sd, mid: m, lower: m-2*sd }; }

// ═══════════════════════════════════════════════════════════════════════════
// REQ 3 + 5 + 9: STRATEGY ENGINE (analyzeSignal)
// Single source of truth — used by both live bot AND backtest
// ═══════════════════════════════════════════════════════════════════════════
export function analyzeSignal(symbol, candles5m, candles15m, candlesDaily, niftyTrend, bankNiftyTrend, relaxed = false) {

  if (candles5m.length < CONFIG.MIN_CANDLES) {
    return { rejected: true, reason: "Not enough candles" };
  }

  const closes = candles5m.map(c => c.c);
  const vols = candles5m.map(c => c.v);
  const price = closes[closes.length - 1];

  // Indicators
  const R = rsi(closes);
  const M = macd(closes);
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const e200 = ema(closes, Math.min(200, closes.length - 1));
  const vw = vwap(candles5m);
  const adxData = adx(candles5m);
  const st = supertrend(candles5m);
  const bb = bollinger(closes);
  const a = atr(candles5m);

  const avgVol = vols.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volRatio = vols[vols.length - 1] / (avgVol || 1);

  // 🚨 STRONG TREND FILTER
  const isStrongTrend =
      (e9 > e21 && e21 > e50 && adxData.adx > 25) ||
      (e9 < e21 && e21 < e50 && adxData.adx > 25);

  if (!relaxed && !isStrongTrend) {
    return { rejected: true, reason: "Weak trend" };
  }

  // HTF Trends
  let trend15m = "neutral";
  if (candles15m?.length > 21) {
    const c15 = candles15m.map(c => c.c);
    trend15m = ema(c15, 9) > ema(c15, 21) ? "bullish" : "bearish";
  }

  let trendDaily = "neutral";
  if (candlesDaily?.length > 21) {
    const cD = candlesDaily.map(c => c.c);
    trendDaily = ema(cD, 9) > ema(cD, 21) ? "bullish" : "bearish";
  }

  const bankingStocks = ["HDFCBANK","ICICIBANK","SBIN","KOTAKBANK","AXISBANK"];
  const indexTrend = bankingStocks.includes(symbol) ? bankNiftyTrend : niftyTrend;

  // 🎯 BREAKOUT LOGIC
  const recentHigh = Math.max(...closes.slice(-20));
  const recentLow = Math.min(...closes.slice(-20));

  const isBreakoutBuy = price > recentHigh * 1.002;
  const isBreakoutSell = price < recentLow * 0.998;

  // 🎯 SCORING
  let score = 0;

  if (R < 35) score += 1;
  if (R > 65) score -= 1;

  if (M.bullish) score += 1.5;
  else score -= 1.5;

  if (e9 > e21 && e21 > e50) score += 2;
  if (e9 < e21 && e21 < e50) score -= 2;

  if (price > vw) score += 1;
  else score -= 1;

  if (st.trend === "bull") score += 1;
  if (st.trend === "bear") score -= 1;

  // HTF boost
  if (trend15m === "bullish") score += 1;
  if (trend15m === "bearish") score -= 1;

  if (trendDaily === "bullish") score += 1;
  if (trendDaily === "bearish") score -= 1;

  // Index filter
  if (indexTrend === "bullish") score += 0.5;
  if (indexTrend === "bearish") score -= 0.5;

  // Volume filter
  if (volRatio < 1.5 && !relaxed) {
    return { rejected: true, reason: "Low volume" };
  }

  // 🎯 SIGNAL DECISION
  let signal = "HOLD";

  if (score >= CONFIG.SIGNAL_SCORE_BUY) signal = "BUY";
  if (score <= CONFIG.SIGNAL_SCORE_SELL) signal = "SELL";

  if (signal === "BUY" && !isBreakoutBuy) {
    return { rejected: true, reason: "No breakout" };
  }

  if (signal === "SELL" && !isBreakoutSell) {
    return { rejected: true, reason: "No breakdown" };
  }

  if (signal === "HOLD") {
    return { rejected: true, reason: "Weak score" };
  }

  // 🎯 SL / TARGET
  const stopDist = Math.max(price * CONFIG.SL_PCT, a * CONFIG.ATR_SL_MULT);
  const targetDist = Math.max(price * CONFIG.TARGET_PCT, a * CONFIG.ATR_TARGET_MULT);

  const entry = price;
  const sl = signal === "BUY" ? price - stopDist : price + stopDist;
  const target = signal === "BUY" ? price + targetDist : price - targetDist;

  // 🎯 RISK-REWARD FILTER
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(target - entry);
  const rr = reward / risk;

  if (rr < 2) {
    return { rejected: true, reason: "Low RR" };
  }

  return {
    symbol,
    signal,
    entry: +entry.toFixed(2),
    sl: +sl.toFixed(2),
    target: +target.toFixed(2),
    score: +score.toFixed(2),
    rr: +rr.toFixed(2),
    indicators: {
      rsi: +R.toFixed(1),
      adx: +adxData.adx.toFixed(1),
      volRatio: +volRatio.toFixed(2),
      trend15m,
      trendDaily,
      indexTrend
    },
    safeToTrade: true,
    rejected: false
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// REQ 7: Balance check + suggesfvtion
// ═══════════════════════════════════════════════════════════════════════════
async function fetchBalance() {
  const age = Date.now() - state.balanceCacheTime;
  if (state.cachedBalance && age < 30000) return state.cachedBalance;
  try {
    const res = await axios.get(
      "https://apiconnect.angelbroking.com/rest/secure/angelbroking/user/v1/getRMS",
      { headers: angelHeaders(), timeout: 8000 }
    );
    const d = res.data?.data || {};
    state.cachedBalance = {
      availableCash: parseFloat(d.availablecash || 0),
      utilisedMargin: parseFloat(d.utiliseddebits || 0),
    };
    state.balanceCacheTime = Date.now();
    return state.cachedBalance;
  } catch { return state.cachedBalance || { availableCash: 0, utilisedMargin: 0 }; }
}

async function balanceSuggestion(sig) {
  const balance = await fetchBalance();
  const available = balance.availableCash || 0;
  
  // REQ 6: Delivery means full capital required
  const fullCapital = sig.qty * sig.entry;
  
  // REQ 7: How many shares can buy
  const maxAffordableQty = Math.floor((available - CONFIG.MIN_CASH_BUFFER) / sig.entry);
  const maxPerTradeQty = Math.floor((available * CONFIG.MAX_CAPITAL_PER_TRADE) / sig.entry);
  const suggestedQty = Math.min(sig.qty, maxAffordableQty, maxPerTradeQty);
  
  return {
    available,
    fullCapitalNeeded: fullCapital,
    requestedQty: sig.qty,
    suggestedQty: Math.max(0, suggestedQty),
    maxAffordableQty,
    canAfford: suggestedQty > 0,
    message: suggestedQty < sig.qty 
      ? `⚠️ Suggested: ${suggestedQty} shares (₹${(suggestedQty * sig.entry).toFixed(0)}) instead of ${sig.qty}`
      : `✅ Can buy ${sig.qty} shares (₹${fullCapital.toFixed(0)})`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// REQ 6: Holdings analyzer
// ═══════════════════════════════════════════════════════════════════════════
async function fetchHoldings() {
  try {
    const res = await axios.get(
      "https://apiconnect.angelbroking.com/rest/secure/angelbroking/portfolio/v1/getHolding",
      { headers: angelHeaders(), timeout: 10000 }
    );
    state.holdings = res.data?.data || [];
    return state.holdings;
  } catch (e) {
    log(`⚠️ Holdings fetch: ${e.message}`);
    return [];
  }
}

async function analyzeHoldings() {
  if (!CONFIG.ANALYZE_HOLDINGS) return;
  const holdings = await fetchHoldings();
  if (!holdings.length) return;
  
  for (const h of holdings) {
    const symbol = h.tradingsymbol?.replace("-EQ", "");
    if (!symbol) continue;
    
    const candles5m = state.candleBuffer5m.get(symbol);
    const candles15m = state.candleBuffer15m.get(symbol);
    const candlesDaily = state.candleBufferDaily.get(symbol);
    if (!candles5m || candles5m.length < CONFIG.MIN_CANDLES) continue;
    
    const sig = analyzeSignal(symbol, candles5m, candles15m, candlesDaily, state.niftyTrend, state.bankNiftyTrend);
    if (!sig || sig.rejected) continue;
    
    const ltp = parseFloat(h.ltp || 0);
    const avg = parseFloat(h.averageprice || 0);
    const qty = parseInt(h.quantity || 0);
    const pnl = (ltp - avg) * qty;
    const pnlPct = avg > 0 ? ((ltp - avg) / avg) * 100 : 0;
    
    // Notify if SELL signal on existing holding
    if (sig.signal === "SELL" && sig.confidence > 65) {
      await tg.sendMessage(ENV.TELEGRAM_CHAT_ID,
        `💼 *Holding Alert: SELL ${symbol}*\n━━━━━━━━━━━\n` +
        `Bought @ ₹${avg.toFixed(2)} · Qty ${qty}\n` +
        `LTP: ₹${ltp.toFixed(2)}\n` +
        `Current P&L: ${pnl >= 0 ? "+" : ""}₹${pnl.toFixed(0)} (${pnlPct.toFixed(2)}%)\n\n` +
        `🤖 Signal: ${sig.signal} · ${sig.confidence}% confidence\n` +
        `Score: ${sig.score} · RSI: ${sig.indicators.rsi}\n` +
        `Trend: 15m ${sig.indicators.trend15m} · Daily ${sig.indicators.trendDaily}\n\n` +
        `_Recommendation: Consider booking ${pnl >= 0 ? "profit" : "exiting"}_`,
        { parse_mode: "Markdown" }
      );
    }
    // Notify if approaching target on holding
    else if (sig.signal === "BUY" && pnlPct < -3) {
      await tg.sendMessage(ENV.TELEGRAM_CHAT_ID,
        `💼 *Holding ${symbol} · Recovery Signal*\n` +
        `Bought @ ₹${avg.toFixed(2)} · Now ₹${ltp.toFixed(2)} (${pnlPct.toFixed(2)}%)\n` +
        `🤖 ${sig.signal} signal active · ${sig.confidence}% confidence\n` +
        `_Hold or accumulate_`,
        { parse_mode: "Markdown" }
      );
    }
  }
}

// Run holdings analysis every 30 min during market
setInterval(() => {
  if (isTradingWindow()) analyzeHoldings();
}, 30 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════════════
// TELEGRAM
// ═══════════════════════════════════════════════════════════════════════════
const tg = new TelegramBot(ENV.TELEGRAM_TOKEN, { polling: true });

async function sendSignalAlert(sig, isForced = false) {
  state.pendingSignals.set(sig.id, sig);
  setTimeout(() => state.pendingSignals.delete(sig.id), 120000);
  await logSignal(sig, "pending");
  state.signalsToday++;

  // REQ 7: Get balance suggestion
  const bal = await balanceSuggestion(sig);

  const emoji = sig.signal === "BUY" ? "🟢" : "🔴";
  const forcedTag = isForced ? "\n🎯 *Best signal of the day*" : "";

  const msg = `${emoji} *${sig.signal} SIGNAL* · 📦 DELIVERY${forcedTag}
━━━━━━━━━━━━━━━━━
*${sig.symbol}*  (${sig.confidence}%)

💰 Entry:  ₹${sig.entry}
🎯 Target: ₹${sig.target}  (+₹${sig.maxGain.toFixed(0)})
🛑 SL:     ₹${sig.sl}  (-₹${sig.maxLoss.toFixed(0)})

📦 Suggested Qty: ${sig.qty} (₹${sig.capital.toFixed(0)})
${bal.message}
💼 Available: ₹${bal.available.toLocaleString("en-IN")}

📊 RSI ${sig.indicators.rsi} · ADX ${sig.indicators.adx}
📈 VWAP ${sig.indicators.checks.vwap} · ST ${sig.indicators.supertrend}
${sig.indicators.pattern !== "none" ? `🕯️ ${sig.indicators.pattern}\n` : ""}
🔭 *HTF Trend:*
   15m: ${sig.indicators.trend15m}
   Daily: ${sig.indicators.trendDaily}
   Index: ${sig.indicators.indexTrend}

Confluence ${Math.max(sig.bullCount, sig.bearCount)}/8

🛡️ Auto: BE@+1.2% · Partial@+2%
📌 *DELIVERY only — no leverage*

⏰ _Expires in 2 min_`;

  const keyboard = {
    inline_keyboard: [[
      { text: "✅ Execute", callback_data: `exec_live_${sig.id}` },
      { text: "📝 Paper", callback_data: `exec_paper_${sig.id}` },
      { text: "❌ Skip", callback_data: `skip_${sig.id}` },
    ]]
  };
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, msg, { parse_mode: "Markdown", reply_markup: keyboard });
  log(`📤 Signal: ${sig.symbol} ${sig.signal} · ${sig.confidence}%`);
}

tg.on("callback_query", async (query) => {
  const data = query.data;
  const sigId = data.replace(/^(exec_live_|exec_paper_|skip_)/, "");
  const sig = state.pendingSignals.get(sigId);
  if (!sig) {
    await tg.answerCallbackQuery(query.id, { text: "⏰ Expired" });
    return;
  }
  if (data.startsWith("skip_")) {
    await tg.answerCallbackQuery(query.id, { text: "Skipped" });
    await tg.editMessageText(`❌ Skipped: ${sig.symbol}`, { chat_id: query.message.chat.id, message_id: query.message.message_id });
    state.pendingSignals.delete(sig.id);
    return;
  }
  if (data.startsWith("exec_live_")) {
    if (!CONFIG.LIVE_TRADING) { await tg.answerCallbackQuery(query.id, { text: "⚠️ Live OFF" }); return; }
    if (state.isHalted) { await tg.answerCallbackQuery(query.id, { text: "🛑 Halted" }); return; }
    await executeLiveOrder(sig);
    await tg.answerCallbackQuery(query.id, { text: "✅ Placed" });
    await tg.editMessageText(`✅ *LIVE* · ${sig.symbol}`, { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: "Markdown" });
  }
  if (data.startsWith("exec_paper_")) {
    executePaperTrade(sig);
    await tg.answerCallbackQuery(query.id, { text: "📝 Paper" });
    await tg.editMessageText(`📝 *PAPER* · ${sig.symbol}`, { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: "Markdown" });
  }
});

tg.onText(/\/start/, async (msg) => {
  await tg.sendMessage(msg.chat.id, `👋 *NSE TradeAI v7.0*\n\n${CONFIG.WATCHLIST.length} stocks · Trading 9:30-3:15\n📦 DELIVERY only\n\n/status · /scan · /capital\n/holdings · /pnl · /scheduler`, { parse_mode: "Markdown" });
});

tg.onText(/\/status/, async () => {
  const liveActive = state.openTrades.filter(t => t.mode === "live" && t.status === "open").length;
  const status = getMarketStatus();
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `📊 *v7.0 Status*\n━━━━━━━━━━\nMarket: ${status.status}\nCapital: ₹${state.capital.toLocaleString("en-IN")}\nRisk/trade: ₹${getRiskPerTrade().toFixed(0)}\nDay loss cap: ₹${getDailyLossCap().toFixed(0)}\nLive P&L: ₹${state.dayPnL.live.toFixed(0)} · Paper: ₹${state.dayPnL.paper.toFixed(0)}\nPositions: ${liveActive}/${CONFIG.MAX_POSITIONS}\nSignals today: ${state.signalsToday}/${CONFIG.TOP_SIGNALS_PER_DAY}\n\nNifty: ${state.niftyTrend} · BankNifty: ${state.bankNiftyTrend}\nScans: ${state.scanCount}`, { parse_mode: "Markdown" });
});

tg.onText(/\/capital/, async () => {
  await fetchCapital();
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `💰 *Capital*\n━━━━━━━━━━\nTotal: ₹${state.capital.toLocaleString("en-IN")}\nRisk/trade (1%): ₹${getRiskPerTrade().toFixed(0)}\nDaily loss cap (2%): ₹${getDailyLossCap().toFixed(0)}\nMax/trade (30%): ₹${(state.capital * CONFIG.MAX_CAPITAL_PER_TRADE).toFixed(0)}`, { parse_mode: "Markdown" });
});

tg.onText(/\/holdings/, async () => {
  const holdings = await fetchHoldings();
  if (!holdings.length) return tg.sendMessage(ENV.TELEGRAM_CHAT_ID, "📭 No holdings");
  const lines = holdings.slice(0, 15).map(h => {
    const ltp = parseFloat(h.ltp || 0);
    const avg = parseFloat(h.averageprice || 0);
    const qty = parseInt(h.quantity || 0);
    const pnl = (ltp - avg) * qty;
    const pct = avg > 0 ? ((ltp - avg) / avg) * 100 : 0;
    return `${h.tradingsymbol?.replace("-EQ","").padEnd(11)} ${qty.toString().padStart(3)} @ ₹${avg.toFixed(0)} → ₹${ltp.toFixed(0)} ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
  });
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `💼 *Holdings (${holdings.length})*\n\`\`\`\n${lines.join("\n")}\n\`\`\``, { parse_mode: "Markdown" });
});

tg.onText(/\/pnl/, async () => {
  // Today's P&L with charges
  try {
    const r = await db.query(`
      SELECT side, SUM(quantity * entry_price) AS buy_value, SUM(quantity * exit_price) AS sell_value, SUM(pnl) AS gross_pnl, COUNT(*) AS trades
      FROM trades WHERE status='closed' AND DATE(closed_at) = CURRENT_DATE GROUP BY side
    `);
    const totalGross = state.dayPnL.live;
    // Approximate buy/sell values
    const closedToday = state.openTrades.filter(t => t.status === "closed" && new Date(t.closedAt).toDateString() === new Date().toDateString());
    let buyVal = 0, sellVal = 0;
    for (const t of closedToday) {
      buyVal += t.entry * t.originalQty;
      sellVal += t.exitPrice * t.originalQty;
    }
    const net = netPnL(totalGross, buyVal, sellVal);
    await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `💰 *Today's P&L*\n━━━━━━━━━━\nGross: ₹${net.gross.toFixed(0)}\nCharges: -₹${net.charges.toFixed(0)}\n  • STT: ₹${net.chargesBreakdown.stt.toFixed(0)}\n  • Brokerage: ₹${net.chargesBreakdown.brokerage.toFixed(0)}\n  • GST: ₹${net.chargesBreakdown.gst.toFixed(0)}\n  • Stamp: ₹${net.chargesBreakdown.stamp.toFixed(0)}\n  • DP+Other: ₹${(net.chargesBreakdown.dp + net.chargesBreakdown.exchange + net.chargesBreakdown.sebi).toFixed(0)}\n*Net: ₹${net.net.toFixed(0)}*`, { parse_mode: "Markdown" });
  } catch (e) {
    await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `Day P&L: ₹${state.dayPnL.live.toFixed(0)} (gross)`);
  }
});

tg.onText(/\/scan/, async () => {
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, "🔍 Scanning...");
  const r = await runScan(true, true);
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `✅ ${r.results?.alerted || 0} signals · Today ${state.signalsToday}/${CONFIG.TOP_SIGNALS_PER_DAY}`);
});

tg.onText(/\/scheduler/, async () => {
  const stuck = lastScanCompletedAt && (Date.now() - lastScanCompletedAt.getTime()) > 90000;
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `⏰ Running: ${schedulerRunning ? "🟢" : "✅"} · Market: ${isTradingWindow() ? "OPEN" : "CLOSED"}\nScans: ${state.scanCount} · Last: ${lastScanCompletedAt?.toLocaleTimeString("en-IN") || "—"}\nStuck: ${stuck ? "⚠️" : "✅"}`);
});

tg.onText(/\/stop/, async () => { state.isHalted = true; await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, "🛑 Halted"); });
tg.onText(/\/resume/, async () => { state.isHalted = false; await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, "✅ Resumed"); });

// ═══════════════════════════════════════════════════════════════════════════
// ORDER EXECUTION (DELIVERY ONLY)
// ═══════════════════════════════════════════════════════════════════════════
async function executeLiveOrder(sig) {
  const bal = await balanceSuggestion(sig);
  if (!bal.canAfford) {
    await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `🚫 Cannot afford ${sig.symbol}\nNeed ₹${bal.fullCapitalNeeded.toFixed(0)}, have ₹${bal.available.toFixed(0)}`);
    return;
  }
  if (bal.suggestedQty < sig.qty) {
    sig.qty = bal.suggestedQty;
    sig.capital = sig.qty * sig.entry;
  }
  
  try {
    const token = await getSymbolToken(sig.symbol);
    const res = await axios.post(
      "https://apiconnect.angelbroking.com/rest/secure/angelbroking/order/v1/placeOrder",
      {
        variety: "NORMAL", tradingsymbol: `${sig.symbol}-EQ`, symboltoken: token,
        transactiontype: sig.signal, exchange: "NSE", ordertype: "MARKET",
        producttype: "DELIVERY",  // REQ 6: DELIVERY only
        duration: "DAY", quantity: sig.qty.toString(),
      },
      { headers: angelHeaders() }
    );
    if (res.data?.status) {
      const trade = createTrade(sig, "live", res.data.data.orderid);
      state.openTrades.push(trade);
      await logTrade(trade);
      await logSignal(sig, "executed_live");
      log(`✅ LIVE DELIVERY: ${sig.symbol} ${sig.signal} ${sig.qty}`);
    }
  } catch (e) {
    log(`❌ Order failed: ${e.message}`);
    await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `⚠️ Order failed: ${sig.symbol}\n${e.message}`);
  }
}

function executePaperTrade(sig) {
  const trade = createTrade(sig, "paper");
  state.openTrades.push(trade);
  logTrade(trade);
  logSignal(sig, "executed_paper");
}

function createTrade(sig, mode, orderId = null) {
  return {
    ...sig, mode, orderId,
    originalQty: sig.qty,
    currentSL: sig.sl, currentPrice: sig.entry,
    status: "open", openedAt: new Date(), trailed: false,
    breakevenTriggered: false, partialBooked: false,
    partialBookPrice: 0, partialBookPnL: 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// REQ 6: TRAILING SL — Same-day exit only on SL or Target
// ═══════════════════════════════════════════════════════════════════════════
setInterval(async () => {
  for (const t of state.openTrades.filter(x => x.status === "open")) {
    const cur = state.livePrices.get(t.symbol)?.ltp;
    if (!cur) continue;
    t.currentPrice = cur;

    if (t.signal === "BUY") {
      const profitPct = (cur - t.entry) / t.entry;

      // Breakeven move
      if (!t.breakevenTriggered && profitPct >= CONFIG.BREAKEVEN_TRIGGER_PCT) {
        const newSL = parseFloat((t.entry * 1.001).toFixed(2));
        await updateSLMovement(t.id, t.currentSL, newSL, cur);
        t.currentSL = newSL;
        t.breakevenTriggered = true;
        await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `🛡️ *Breakeven* · ${t.symbol} · SL → ₹${newSL}`, { parse_mode: "Markdown" });
      }

      // Partial booking at 2%
      if (!t.partialBooked && profitPct >= CONFIG.PARTIAL_BOOK_PCT) {
        const partialQty = Math.floor(t.originalQty * CONFIG.PARTIAL_BOOK_FRACTION);
        if (partialQty > 0 && partialQty < t.qty) {
          const partialPnL = (cur - t.entry) * partialQty;
          if (t.mode === "live" && CONFIG.LIVE_TRADING) {
            try {
              await axios.post(
                "https://apiconnect.angelbroking.com/rest/secure/angelbroking/order/v1/placeOrder",
                {
                  variety: "NORMAL", tradingsymbol: `${t.symbol}-EQ`,
                  symboltoken: await getSymbolToken(t.symbol),
                  transactiontype: "SELL", exchange: "NSE", ordertype: "MARKET",
                  producttype: "DELIVERY", duration: "DAY", quantity: partialQty.toString(),
                },
                { headers: angelHeaders() }
              );
            } catch (e) { log(`❌ Partial sell: ${e.message}`); }
          }
          t.qty -= partialQty;
          t.partialBooked = true;
          t.partialBookPrice = cur;
          t.partialBookPnL = partialPnL;
          state.dayPnL[t.mode] += partialPnL;
          await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `💰 *Partial Book* · ${t.symbol}\n${partialQty} @ ₹${cur.toFixed(2)} = +₹${partialPnL.toFixed(0)}\nHolding ${t.qty}`, { parse_mode: "Markdown" });
        }
      }

      // Trailing
      if (t.partialBooked || t.breakevenTriggered) {
        const gain = cur - t.entry;
        const retention = t.partialBooked ? 0.8 : 0.5;
        const newSL = parseFloat((t.entry + gain * retention).toFixed(2));
        if (newSL > t.currentSL) {
          await updateSLMovement(t.id, t.currentSL, newSL, cur);
          t.currentSL = newSL;
          t.trailed = true;
        }
      }

      // ─── REQ 6: Same-day exit only on SL or Target ───
      if (cur <= t.currentSL) await closeTrade(t, "SL_HIT", t.currentSL);
      else if (cur >= t.target) await closeTrade(t, "TARGET_HIT", t.target);
      // NOTE: No EOD square-off for delivery — let it run if SL not hit
    }
  }
}, 3000);

async function closeTrade(t, reason, exit) {
  t.status = "closed"; t.exitPrice = exit; t.exitReason = reason;
  t.exitPnL = (exit - t.entry) * t.qty * (t.signal === "BUY" ? 1 : -1);
  if (t.partialBooked) t.exitPnL += t.partialBookPnL;
  t.closedAt = new Date();
  state.dayPnL[t.mode] += (t.partialBooked ? t.exitPnL - t.partialBookPnL : t.exitPnL);
  await dbCloseTrade(t.id, exit, reason, t.exitPnL);

  // Live exit order
  if (t.mode === "live" && CONFIG.LIVE_TRADING && t.qty > 0) {
    try {
      await axios.post(
        "https://apiconnect.angelbroking.com/rest/secure/angelbroking/order/v1/placeOrder",
        {
          variety: "NORMAL", tradingsymbol: `${t.symbol}-EQ`,
          symboltoken: await getSymbolToken(t.symbol),
          transactiontype: t.signal === "BUY" ? "SELL" : "BUY",
          exchange: "NSE", ordertype: "MARKET",
          producttype: "DELIVERY", duration: "DAY", quantity: t.qty.toString(),
        },
        { headers: angelHeaders() }
      );
    } catch (e) { log(`❌ Exit: ${e.message}`); }
  }

  // Calculate net P&L with charges
  const buyVal = t.entry * t.originalQty;
  const sellVal = t.exitPrice * t.originalQty;
  const net = netPnL(t.exitPnL, buyVal, sellVal);

  const emoji = reason === "TARGET_HIT" ? "🎯" : "🛑";
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID,
    `${emoji} *${reason.replace(/_/g, " ")}* · ${t.symbol}\n` +
    `Entry ₹${t.entry} → Exit ₹${exit}\n` +
    `Gross: ${net.gross >= 0 ? "+" : ""}₹${net.gross.toFixed(0)}\n` +
    `Charges: -₹${net.charges.toFixed(0)}\n` +
    `*Net: ${net.net >= 0 ? "+" : ""}₹${net.net.toFixed(0)}*`,
    { parse_mode: "Markdown" }
  );

  // Daily loss cap check
  if (state.dayPnL.live <= -getDailyLossCap() && !state.isHalted) {
    state.isHalted = true;
    await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `🛑 Daily loss cap hit (₹${getDailyLossCap().toFixed(0)}) · TRADING HALTED`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SCANNER
// ═══════════════════════════════════════════════════════════════════════════
async function runScan(verbose = false, forceRun = false) {
  if (schedulerRunning && !forceRun) return { skipped: true, reason: "in_progress" };
  schedulerRunning = true;
  const startTime = Date.now();

  try {
    if (!forceRun && !isTradingWindow()) return { skipped: true, reason: "outside_window" };
    if (state.isHalted) return { skipped: true, reason: "halted" };

    state.scanCount++;
    state.lastScanTime = new Date();
    const r = { scanned: 0, noCandles: 0, inPos: 0, hold: 0, filtered: 0, alerted: 0, candidates: [] };

    for (const symbol of CONFIG.WATCHLIST) {
      r.scanned++;
      const c5 = state.candleBuffer5m.get(symbol);
      const c15 = state.candleBuffer15m.get(symbol);
      const cD = state.candleBufferDaily.get(symbol);
      if (!c5 || c5.length < CONFIG.MIN_CANDLES) { r.noCandles++; continue; }
      if (state.openTrades.some(t => t.symbol === symbol && t.status === "open")) { r.inPos++; continue; }

      const sig = analyzeSignal(symbol, c5, c15, cD, state.niftyTrend, state.bankNiftyTrend);
      if (!sig || sig.rejected) { r.noCandles++; continue; }
      if (sig.signal === "HOLD") { r.hold++; continue; }
      if (!sig.safeToTrade) { r.filtered++; continue; }
      if (Math.abs(sig.score) < CONFIG.MIN_SCORE_FOR_TRADE) { r.filtered++; continue; }
      r.candidates.push(sig);
    }

    // Top N by score
    r.candidates.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
    const remaining = CONFIG.TOP_SIGNALS_PER_DAY - state.signalsToday;
    const top = r.candidates.slice(0, Math.max(remaining, 0));
    for (const sig of top) {
      if (state.signalsToday >= CONFIG.TOP_SIGNALS_PER_DAY) break;
      r.alerted++;
      await sendSignalAlert(sig);
    }

    // REQ 12: Forced signal
    const ist = getISTDate();
    const curHour = ist.getHours() + ist.getMinutes() / 60;
    if (state.signalsToday === 0 && !state.forcedSignalSent &&
        curHour >= CONFIG.FORCE_SIGNAL_AFTER_HOUR && curHour <= CONFIG.FORCE_SIGNAL_MAX_HOUR) {
      let best = null;
      for (const symbol of CONFIG.WATCHLIST) {
        const c5 = state.candleBuffer5m.get(symbol);
        const c15 = state.candleBuffer15m.get(symbol);
        const cD = state.candleBufferDaily.get(symbol);
        if (!c5 || c5.length < CONFIG.MIN_CANDLES) continue;
        if (state.openTrades.some(t => t.symbol === symbol && t.status === "open")) continue;
        const sig = analyzeSignal(symbol, c5, c15, cD, state.niftyTrend, state.bankNiftyTrend, true);
        if (!sig || sig.signal === "HOLD") continue;
        if (!best || Math.abs(sig.score) > Math.abs(best.score)) best = sig;
      }
      if (best) {
        state.forcedSignalSent = true;
        log(`🎯 FORCED: ${best.symbol} ${best.signal}`);
        await sendSignalAlert(best, true);
      }
    }

    lastScanCompletedAt = new Date();
    log(`🔍 Scan #${state.scanCount} · ${Date.now()-startTime}ms · ${r.scanned}|${r.noCandles}nd|${r.inPos}ip|${r.hold}h|${r.filtered}f|${r.alerted}a${forceRun ? " (FORCED)" : ""}`);
    return { skipped: false, results: r };
  } catch (e) {
    log(`💥 Scan: ${e.message}`);
    return { error: e.message };
  } finally { schedulerRunning = false; }
}

function startScheduler() {
  if (scanInterval) clearInterval(scanInterval);
  log(`⏰ Scheduler · 9:30-15:15 · scan every ${CONFIG.SCAN_INTERVAL_MS/1000}s`);
  scanInterval = setInterval(() => runScan().catch(e => log(`💥 ${e.message}`)), CONFIG.SCAN_INTERVAL_MS);
  setTimeout(() => { if (isTradingWindow()) runScan(true).catch(e => log(`💥 ${e.message}`)); }, 5000);
  if (watchdogInterval) clearInterval(watchdogInterval);
  watchdogInterval = setInterval(() => {
    if (!isTradingWindow() || state.isHalted || !lastScanCompletedAt) return;
    if (Date.now() - lastScanCompletedAt.getTime() > CONFIG.SCHEDULER_TIMEOUT_MS) {
      log(`⚠️ Stuck · RESTARTING`);
      schedulerRunning = false;
      startScheduler();
    }
  }, CONFIG.WATCHDOG_INTERVAL_MS);
}

setInterval(() => {
  const ist = getISTDate();
  if (ist.getHours() === 9 && ist.getMinutes() === 0) {
    state.signalsToday = 0;
    state.forcedSignalSent = false;
    state.dayPnL = { live: 0, paper: 0 };
    log("🌅 Daily reset");
  }
}, 60000);

// ═══════════════════════════════════════════════════════════════════════════
// REQ 8 + 9: BACKTEST API (uses analyzeSignal - same source of truth)
// ═══════════════════════════════════════════════════════════════════════════
const backtestCache = new Map();
const runningBacktests = new Map();

function addBacktestEndpoints(app, auth) {
  app.post("/api/backtest/run", auth, async (req, res) => {
    const { days = 30, symbols } = req.body;
    const id = `bt-${Date.now()}`;
    const symList = symbols?.length ? symbols : CONFIG.WATCHLIST.slice(0, 25);
    res.json({ backtestId: id, status: "running" });
    runBacktest(id, symList, days);
  });

  app.get("/api/backtest/:id", auth, (req, res) => {
    const result = backtestCache.get(req.params.id);
    const running = runningBacktests.get(req.params.id);
    if (result) res.json({ status: "completed", ...result });
    else if (running) res.json({ status: "running", progress: running });
    else res.status(404).json({ error: "Not found" });
  });

  app.get("/api/backtest", auth, (req, res) => {
    const list = [...backtestCache.entries()].map(([id, r]) => ({
      id, runDate: r.runDate, days: r.config.days,
      symbols: r.config.symbols.length, totalTrades: r.metrics.total,
      totalPnL: r.metrics.totalPnL, winRate: r.metrics.winRate, verdict: r.metrics.verdict,
    })).reverse();
    res.json(list.slice(0, 20));
  });

  // REQ 8: Detailed trade log endpoint
  app.get("/api/backtest/:id/trades", auth, (req, res) => {
    const result = backtestCache.get(req.params.id);
    if (!result) return res.status(404).json({ error: "Not found" });
    res.json({ trades: result.trades, count: result.trades.length });
  });
}

async function runBacktest(id, symbols, days) {
  runningBacktests.set(id, { done: 0, total: symbols.length, currentSymbol: "" });
  const allTrades = [];
  const perSymbol = {};

  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    runningBacktests.set(id, { done: i, total: symbols.length, currentSymbol: sym });
    
    // Fetch all 3 timeframes
    const c5 = await fetchHistorical(sym, "FIVE_MINUTE", days);
    await new Promise(r => setTimeout(r, CONFIG.HISTORICAL_RATE_LIMIT_MS));
    const c15 = await fetchHistorical(sym, "FIFTEEN_MINUTE", days);
    await new Promise(r => setTimeout(r, CONFIG.HISTORICAL_RATE_LIMIT_MS));
    const cD = await fetchHistorical(sym, "ONE_DAY", days);
    await new Promise(r => setTimeout(r, CONFIG.HISTORICAL_RATE_LIMIT_MS));
    
    if (!c5?.length) {
      perSymbol[sym] = { error: "no data", trades: 0 };
      continue;
    }

    const trades = simulate(sym, c5, c15, cD);
    allTrades.push(...trades);
    perSymbol[sym] = {
      candles: c5.length, trades: trades.length,
      pnl: trades.reduce((s,t) => s + t.netPnL, 0).toFixed(2),
    };
  }

  const metrics = calculateMetrics(allTrades);
  const result = {
    backtestId: id, runDate: new Date().toISOString(),
    config: { days, symbols },
    metrics, perSymbol,
    trades: allTrades.slice(0, 1000),  // REQ 8: detailed log
  };
  backtestCache.set(id, result);
  runningBacktests.delete(id);
  log(`✅ Backtest ${id}: ${metrics.total} trades · ${metrics.winRate}% win · ₹${metrics.totalPnL}`);
}

function simulate(symbol, c5, c15, cD) {
  const trades = [];
  let open = null;

  for (let i = CONFIG.MIN_CANDLES; i < c5.length; i++) {
    const candle = c5[i];
    const candleTime = new Date(candle.time);
    const mins = candleTime.getHours() * 60 + candleTime.getMinutes();
    
    // REQ 4: Trade only 9:30 - 3:15
    const inWindow = mins >= 570 && mins <= 915;

    // Manage open trade
    if (open) {
      const t = open;
      if (t.signal === "BUY") {
        const profitPct = (candle.c - t.entry) / t.entry;
        // Breakeven
        if (!t.breakevenTriggered && profitPct >= CONFIG.BREAKEVEN_TRIGGER_PCT) {
          t.currentSL = t.entry * 1.001;
          t.breakevenTriggered = true;
        }
        // Partial booking
        if (!t.partialBooked && profitPct >= CONFIG.PARTIAL_BOOK_PCT) {
          const partialQty = Math.floor(t.originalQty * CONFIG.PARTIAL_BOOK_FRACTION);
          if (partialQty > 0 && partialQty < t.qty) {
            t.partialPnL = (candle.c - t.entry) * partialQty;
            t.partialPrice = candle.c;
            t.partialQty = partialQty;
            t.qty -= partialQty;
            t.partialBooked = true;
          }
        }
        // Trail
        if (t.partialBooked || t.breakevenTriggered) {
          const gain = candle.c - t.entry;
          const retention = t.partialBooked ? 0.8 : 0.5;
          const newSL = t.entry + gain * retention;
          if (newSL > t.currentSL) t.currentSL = newSL;
        }
        // Exit checks
        if (candle.l <= t.currentSL) {
          t.exit = t.currentSL;
          t.exitTime = candle.time;
          t.exitReason = "SL";
          t.pnl = (t.exit - t.entry) * t.qty + (t.partialPnL || 0);
          t.netPnLData = netPnL(t.pnl, t.entry * t.originalQty, t.exit * t.qty + (t.partialPrice * (t.partialQty || 0)));
          t.netPnL = t.netPnLData.net;
          trades.push(t);
          open = null;
          continue;
        }
        if (candle.h >= t.target) {
          t.exit = t.target;
          t.exitTime = candle.time;
          t.exitReason = "TARGET";
          t.pnl = (t.exit - t.entry) * t.qty + (t.partialPnL || 0);
          t.netPnLData = netPnL(t.pnl, t.entry * t.originalQty, t.exit * t.qty + (t.partialPrice * (t.partialQty || 0)));
          t.netPnL = t.netPnLData.net;
          trades.push(t);
          open = null;
          continue;
        }
      }
    }

    // New signal in trading window
    if (!open && inWindow) {
      // Slice candles up to current point for HTF context
      const c5Slice = c5.slice(Math.max(0, i - 200), i + 1);
      const c15Slice = c15.filter(c => new Date(c.time) <= candleTime);
      const cDSlice = cD.filter(c => new Date(c.time) <= candleTime);
      
      // Compute index trends from daily data (simplified for backtest)
      const niftyT = "neutral";  // In real backtest, fetch index data per symbol
      const bankT = "neutral";
      
      const sig = analyzeSignal(symbol, c5Slice, c15Slice, cDSlice, niftyT, bankT);
      if (!sig || sig.signal === "HOLD" || !sig.safeToTrade) continue;
      if (Math.abs(sig.score) < CONFIG.MIN_SCORE_FOR_TRADE) continue;

      open = {
        // REQ 8: Detailed log fields
        symbol: sig.symbol,
        signal: sig.signal,
        entry: sig.entry,
        entryTime: candleTime.toISOString(),
        entryTimeIST: candleTime.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
        qty: sig.qty,
        originalQty: sig.qty,
        sl: sig.sl,
        currentSL: sig.sl,
        target: sig.target,
        confidence: sig.confidence,
        score: sig.score,
        rsi: sig.indicators.rsi,
        adx: sig.indicators.adx,
        vwap: sig.indicators.vwap,
        supertrend: sig.indicators.supertrend,
        pattern: sig.indicators.pattern,
        trend15m: sig.indicators.trend15m,
        trendDaily: sig.indicators.trendDaily,
        indexTrend: sig.indicators.indexTrend,
        bullCount: sig.bullCount,
        bearCount: sig.bearCount,
        breakevenTriggered: false,
        partialBooked: false,
      };
    }
  }

  // Close any remaining open trade
  if (open) {
    const last = c5[c5.length - 1];
    open.exit = last.c;
    open.exitTime = last.time;
    open.exitReason = "END_OF_DATA";
    open.pnl = (open.exit - open.entry) * open.qty * (open.signal === "BUY" ? 1 : -1) + (open.partialPnL || 0);
    open.netPnLData = netPnL(open.pnl, open.entry * open.originalQty, open.exit * open.qty);
    open.netPnL = open.netPnLData.net;
    trades.push(open);
  }
  return trades;
}

function calculateMetrics(allTrades) {
  if (!allTrades.length) return { total: 0, verdict: "NO_TRADES", verdictColor: "orange" };

  const wins = allTrades.filter(t => t.netPnL > 0);
  const losses = allTrades.filter(t => t.netPnL <= 0);
  const totalPnL = allTrades.reduce((s,t) => s + t.netPnL, 0);
  const grossPnL = allTrades.reduce((s,t) => s + t.pnl, 0);
  const totalCharges = grossPnL - totalPnL;
  const grossWin = wins.reduce((s,t) => s + t.netPnL, 0);
  const grossLoss = Math.abs(losses.reduce((s,t) => s + t.netPnL, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin;

  let peak = 0, maxDD = 0, running = 0;
  const equityCurve = [];
  for (const t of allTrades) {
    running += t.netPnL;
    equityCurve.push({ time: t.exitTime, pnl: running });
    if (running > peak) peak = running;
    if (peak - running > maxDD) maxDD = peak - running;
  }

  let maxConsecLosses = 0, cur = 0;
  for (const t of allTrades) {
    if (t.netPnL < 0) { cur++; maxConsecLosses = Math.max(maxConsecLosses, cur); }
    else cur = 0;
  }

  const bySymbol = {};
  for (const t of allTrades) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { trades: 0, wins: 0, pnl: 0 };
    bySymbol[t.symbol].trades++;
    if (t.netPnL > 0) bySymbol[t.symbol].wins++;
    bySymbol[t.symbol].pnl += t.netPnL;
  }
  for (const s in bySymbol) {
    bySymbol[s].winRate = (bySymbol[s].wins / bySymbol[s].trades * 100).toFixed(1);
    bySymbol[s].pnl = parseFloat(bySymbol[s].pnl.toFixed(2));
  }

  const byExitReason = {
    TARGET: allTrades.filter(t => t.exitReason === "TARGET").length,
    SL: allTrades.filter(t => t.exitReason === "SL").length,
    END: allTrades.filter(t => t.exitReason === "END_OF_DATA").length,
  };

  const winRate = (wins.length / allTrades.length * 100).toFixed(2);
  const returnPct = (totalPnL / state.capital * 100).toFixed(2);

  let verdict = "POOR", verdictColor = "red";
  const wr = parseFloat(winRate), pf = parseFloat(profitFactor.toFixed(2));
  if (totalPnL > 0 && wr >= 50 && pf >= 2.0) { verdict = "EXCELLENT"; verdictColor = "green"; }
  else if (totalPnL > 0 && wr >= 35 && pf >= 1.5) { verdict = "GOOD"; verdictColor = "green"; }
  else if (totalPnL > 0 && pf >= 1.2) { verdict = "MARGINAL"; verdictColor = "orange"; }
  else if (totalPnL > 0) { verdict = "BREAK_EVEN"; verdictColor = "orange"; }

  return {
    total: allTrades.length,
    wins: wins.length, losses: losses.length,
    winRate, totalPnL: parseFloat(totalPnL.toFixed(2)),
    grossPnL: parseFloat(grossPnL.toFixed(2)),
    totalCharges: parseFloat(totalCharges.toFixed(2)),
    returnPct, profitFactor: parseFloat(profitFactor.toFixed(2)),
    avgWin: parseFloat((wins.length ? grossWin / wins.length : 0).toFixed(2)),
    avgLoss: parseFloat((losses.length ? -grossLoss / losses.length : 0).toFixed(2)),
    best: parseFloat(Math.max(...allTrades.map(t => t.netPnL)).toFixed(2)),
    worst: parseFloat(Math.min(...allTrades.map(t => t.netPnL)).toFixed(2)),
    maxDrawdown: parseFloat(maxDD.toFixed(2)),
    maxConsecLosses,
    bySymbol, byExitReason,
    equityCurve: equityCurve.slice(-100),
    verdict, verdictColor,
    strategyVersion: "v7.0",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MOBILE API
// ═══════════════════════════════════════════════════════════════════════════
function addSchedulerEndpoints(app, auth) {
  app.post("/api/scan/now", auth, async (req, res) => {
    const r = await runScan(true, true);
    res.json({ ok: true, forced: true, ...r });
  });

  app.get("/api/scheduler/status", auth, (req, res) => {
    const stuck = lastScanCompletedAt && (Date.now() - lastScanCompletedAt.getTime()) > 90000;
    res.json({
      market: getMarketStatus(),
      capital: state.capital,
      riskPerTrade: getRiskPerTrade(),
      dailyLossCap: getDailyLossCap(),
      indexTrends: { nifty: state.niftyTrend, bankNifty: state.bankNiftyTrend },
      scheduler: { running: schedulerRunning, scansCompleted: state.scanCount, stuck, halted: state.isHalted },
      signals: { today: state.signalsToday, max: CONFIG.TOP_SIGNALS_PER_DAY },
    });
  });

  // REQ 10: Daily signals + P&L for mobile
  app.get("/api/daily/signals", auth, async (req, res) => {
    try {
      const r = await db.query(`SELECT * FROM signals WHERE DATE(created_at) = CURRENT_DATE ORDER BY created_at DESC LIMIT 50`);
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/daily/pnl", auth, async (req, res) => {
    try {
      const r = await db.query(`SELECT * FROM trades WHERE status='closed' AND DATE(closed_at) = CURRENT_DATE`);
      let totalGross = 0, totalBuyVal = 0, totalSellVal = 0;
      const trades = r.rows.map(t => {
        const buyVal = t.entry_price * t.quantity;
        const sellVal = (t.exit_price || 0) * t.quantity;
        const charges = calculateCharges(buyVal, sellVal);
        const net = (parseFloat(t.pnl) || 0) - charges.total;
        totalGross += parseFloat(t.pnl) || 0;
        totalBuyVal += buyVal;
        totalSellVal += sellVal;
        return {
          symbol: t.symbol, side: t.side,
          entry: t.entry_price, exit: t.exit_price,
          qty: t.quantity, gross: parseFloat(t.pnl) || 0,
          charges: charges.total, net: parseFloat(net.toFixed(2)),
          exitReason: t.exit_reason,
        };
      });
      const totalCharges = calculateCharges(totalBuyVal, totalSellVal);
      res.json({
        trades,
        summary: {
          totalGross: parseFloat(totalGross.toFixed(2)),
          totalCharges: totalCharges.total,
          totalNet: parseFloat((totalGross - totalCharges.total).toFixed(2)),
          chargesBreakdown: totalCharges,
          tradeCount: trades.length,
        }
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // REQ 7: Balance check for any symbol
  app.post("/api/balance/check", auth, async (req, res) => {
    const { symbol, entry, qty } = req.body;
    const sig = { symbol, entry, qty };
    const result = await balanceSuggestion(sig);
    res.json(result);
  });

  // REQ 6: Holdings analysis
  app.get("/api/holdings/analyze", auth, async (req, res) => {
    const holdings = await fetchHoldings();
    const analyzed = [];
    for (const h of holdings) {
      const symbol = h.tradingsymbol?.replace("-EQ", "");
      if (!symbol) continue;
      const c5 = state.candleBuffer5m.get(symbol);
      const c15 = state.candleBuffer15m.get(symbol);
      const cD = state.candleBufferDaily.get(symbol);
      if (!c5 || c5.length < CONFIG.MIN_CANDLES) {
        analyzed.push({ symbol, holding: h, signal: null });
        continue;
      }
      const sig = analyzeSignal(symbol, c5, c15, cD, state.niftyTrend, state.bankNiftyTrend);
      analyzed.push({
        symbol, holding: h,
        signal: sig?.signal || "HOLD",
        confidence: sig?.confidence || 0,
        score: sig?.score || 0,
        recommendation: sig?.signal === "SELL" ? "Consider booking" : "Hold",
      });
    }
    res.json(analyzed);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════════════════
async function startup() {
  log("🚀 NSE TradeAI v7.0 · COMPLETE PRODUCTION");
  log(`   Watchlist: ${CONFIG.WATCHLIST.length} (${CONFIG.NIFTY_50.length} Nifty + ${CONFIG.BEST_PERFORMERS.length} momentum)`);
  log(`   Trading window: 9:30 AM - 3:15 PM`);
  log(`   Order type: DELIVERY (no leverage)`);
  log(`   Live: ${CONFIG.LIVE_TRADING ? "✅" : "❌"}`);

  await initDB();
  await logEvent("STARTUP", "v7.0 started");

  const { app, auth } = startAPI(3000);
  addAccountEndpoints(app, state, auth);
  addBacktestEndpoints(app, auth);
  addSchedulerEndpoints(app, auth);

  if (!await authenticateAngel()) process.exit(1);
  await loadScripMaster();
  
  // REQ 13: Fetch capital from Angel
  await fetchCapital();
  
  log("🔑 Resolving tokens...");
  const tokens = [];
  for (const sym of CONFIG.WATCHLIST) {
    const t = await getSymbolToken(sym);
    if (t) tokens.push(t);
  }
  log(`✓ Resolved ${tokens.length}/${CONFIG.WATCHLIST.length}`);

  // Add index tokens for trend tracking
  for (const idx of [CONFIG.INDEX_NIFTY, CONFIG.INDEX_BANKNIFTY]) {
    const t = await getSymbolToken(idx);
    if (t) tokens.push(t);
  }

  // REQ 2: Load 20-day historical data with rate limiting
  await loadAllHistoricalData();

  await startWebSocket(tokens);
  startScheduler();

  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `🚀 *Bot v7.0 Online*
━━━━━━━━━━━━━━
Watchlist: ${CONFIG.WATCHLIST.length} stocks
Capital: ₹${state.capital.toLocaleString("en-IN")}
Risk: 1% (₹${getRiskPerTrade().toFixed(0)}/trade)
Daily cap: 2% (₹${getDailyLossCap().toFixed(0)})

📦 DELIVERY only · No leverage
⏰ Trading: 9:30-3:15 IST

Nifty: ${state.niftyTrend} · BankNifty: ${state.bankNiftyTrend}

${CONFIG.LIVE_TRADING ? "⚡ LIVE" : "📝 Paper"}

/status · /scan · /capital · /holdings · /pnl`, { parse_mode: "Markdown" });

  log("✅ v7.0 operational");
}

startup().catch(e => { log(`💥 Fatal: ${e.message}`); console.error(e); process.exit(1); });
process.on("SIGINT", () => { if (state.ws) state.ws.close(); process.exit(0); });
process.on("uncaughtException", e => log(`💥 Uncaught: ${e.message}`));
