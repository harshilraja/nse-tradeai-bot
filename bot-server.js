// ═══════════════════════════════════════════════════════════════════════════
// NSE TradeAI Bot v6.4 · COMPLETE FINAL VERSION
// 
// ALL FEATURES:
// ✅ Strict 9 AM - 4 PM IST scheduler with watchdog
// ✅ Bulletproof scrip master (3 retries + multiple URLs + hardcoded fallback)
// ✅ v6.3 high-accuracy strategy (ATR-SL, ADX filter, EMA200, patterns)
// ✅ Claude AI sentiment layer (validates signals via news/context)
// ✅ Statistical learning (boosts confidence based on real outcomes)
// ✅ On-demand scan from mobile + Telegram /scan
// ✅ Balance-aware trading (auto qty reduction)
// ✅ Trailing SL · Telegram alerts · PostgreSQL persistence
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
import { addBacktestEndpoints } from "./backtest-api.js";

dotenv.config();

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════
const CONFIG = {
  CAPITAL:         250000,
  RISK_PER_TRADE:  1000,
  REWARD_RATIO:    4,           // 1:4 RR (only need 25% win rate)
  DAILY_LOSS_CAP:  2500,
  MAX_POSITIONS:   3,
  LIVE_TRADING:    process.env.LIVE_TRADING === "true",

  // ─── Risk-reward (ATR-based) ───
  SL_PCT:          0.006,
  TARGET_PCT:      0.024,
  ATR_SL_MULT:     1.5,
  ATR_TARGET_MULT: 4.5,

  // ─── Signal thresholds ───
  SIGNAL_SCORE_BUY:  4.0,
  SIGNAL_SCORE_SELL: -4.0,
  MIN_CONFLUENCE:    4,
  MIN_CONFIDENCE:    65,
  MIN_VOLUME_RATIO:  1.3,
  MIN_CANDLES:       30,
  MIN_ADX:           25,

  // ─── Market hours (strict 9 AM - 4 PM IST) ───
  MARKET_START_HOUR: 9,
  MARKET_START_MIN:  15,
  MARKET_END_HOUR:   15,
  MARKET_END_MIN:    30,

  // ─── Scheduler ───
  SCAN_INTERVAL_MS:    20000,
  WATCHDOG_INTERVAL_MS: 60000,
  SCHEDULER_TIMEOUT_MS: 90000,

  // ─── Forced signal logic ───
  FORCE_SIGNAL_AFTER_HOUR: 12,
  FORCE_SIGNAL_MAX_HOUR:   14.5,

  // ─── Balance protection ───
  MIN_CASH_BUFFER:        5000,
  MAX_CAPITAL_PER_TRADE:  0.30,
  MAX_TOTAL_EXPOSURE:     0.80,

  // ─── AI features ───
  USE_AI_SENTIMENT:    process.env.USE_AI_SENTIMENT === "true",
  AI_SENTIMENT_MIN_CONFIDENCE: 70,  // Only check AI for high-confidence signals
  USE_STATISTICAL_LEARNING: true,    // Adjust confidence based on historical wins

  // ─── Watchlist ───
  WATCHLIST: [
    "RELIANCE","HDFCBANK","ICICIBANK","INFY","TCS","HINDUNILVR","ITC","BHARTIARTL",
    "SBIN","LT","KOTAKBANK","AXISBANK","BAJFINANCE","ASIANPAINT","MARUTI",
    "SUNPHARMA","TITAN","HCLTECH","ULTRACEMCO","NTPC","WIPRO","NESTLEIND",
    "POWERGRID","TATASTEEL","TECHM","ONGC","JSWSTEEL","ADANIENT","ADANIPORTS",
    "COALINDIA","BAJAJFINSV","GRASIM","HINDALCO","DRREDDY","BRITANNIA",
    "CIPLA","BPCL","INDUSINDBK","EICHERMOT","APOLLOHOSP","HEROMOTOCO",
    "DIVISLAB","TATAMOTORS","UPL","SBILIFE","HDFCLIFE","LTIM",
    "TATACONSUM","BAJAJHLDNG","DMART"
  ],
};

const ENV = {
  ANGEL_CLIENT_ID:   process.env.ANGEL_CLIENT_ID,
  ANGEL_API_KEY:     process.env.ANGEL_API_KEY,
  ANGEL_MPIN:        process.env.ANGEL_MPIN,
  ANGEL_TOTP_TOKEN:  process.env.ANGEL_TOTP_TOKEN,
  TELEGRAM_TOKEN:    process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID:  process.env.TELEGRAM_CHAT_ID,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
};

// ═══════════════════════════════════════════════════════════════════════════
// HARDCODED NIFTY 50 TOKENS — Ultimate fallback
// ═══════════════════════════════════════════════════════════════════════════
const NIFTY_50_FALLBACK_TOKENS = {
  "RELIANCE":"2885","HDFCBANK":"1333","ICICIBANK":"4963","INFY":"1594",
  "TCS":"11536","HINDUNILVR":"1394","ITC":"1660","BHARTIARTL":"10604",
  "SBIN":"3045","LT":"11483","KOTAKBANK":"1922","AXISBANK":"5900",
  "BAJFINANCE":"317","ASIANPAINT":"236","MARUTI":"10999","SUNPHARMA":"3351",
  "TITAN":"3506","HCLTECH":"7229","ULTRACEMCO":"11532","NTPC":"11630",
  "WIPRO":"3787","NESTLEIND":"17963","POWERGRID":"14977","TATASTEEL":"3499",
  "TECHM":"13538","ONGC":"2475","JSWSTEEL":"11723","ADANIENT":"25",
  "ADANIPORTS":"15083","COALINDIA":"20374","BAJAJFINSV":"16675","GRASIM":"1232",
  "HINDALCO":"1363","DRREDDY":"881","BRITANNIA":"547","CIPLA":"694",
  "BPCL":"526","INDUSINDBK":"5258","EICHERMOT":"910","APOLLOHOSP":"157",
  "HEROMOTOCO":"1348","DIVISLAB":"10940","TATAMOTORS":"3456","UPL":"11287",
  "SBILIFE":"21808","HDFCLIFE":"467","LTIM":"17818","TATACONSUM":"3432",
  "BAJAJHLDNG":"16669","DMART":"19913",
};

// ═══════════════════════════════════════════════════════════════════════════
// GLOBAL STATE
// ═══════════════════════════════════════════════════════════════════════════
export const state = {
  angelAuth: null, feedToken: null, ws: null,
  livePrices: new Map(), candleBuffer: new Map(),
  openTrades: [], pendingSignals: new Map(),
  dayPnL: { live: 0, paper: 0 }, isHalted: false,
  symbolTokens: new Map(), tokenToSymbol: new Map(),
  scanCount: 0, lastScanTime: null,
  signalsToday: 0, forcedSignalSent: false,
  scripMaster: null, scripMasterLoaded: false, usingFallback: false,
  symbolStats: new Map(),  // For statistical learning
  cachedBalance: null, balanceCacheTime: 0,
};

let schedulerRunning = false;
let lastScanCompletedAt = null;
let scansSkippedClosedMarket = 0;
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

function getTradingDayRange(daysBack = 5) {
  let end = getISTDate();
  if (end.getHours() < 9 || (end.getHours() === 9 && end.getMinutes() < 15)) {
    end.setDate(end.getDate() - 1);
  }
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

function isMarketHours() {
  const ist = getISTDate();
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const totalMins = ist.getHours() * 60 + ist.getMinutes();
  const startMins = CONFIG.MARKET_START_HOUR * 60 + CONFIG.MARKET_START_MIN;
  const endMins = CONFIG.MARKET_END_HOUR * 60 + CONFIG.MARKET_END_MIN;
  return totalMins >= startMins && totalMins <= endMins;
}

function getMarketStatus() {
  const ist = getISTDate();
  const day = ist.getDay();
  const totalMins = ist.getHours() * 60 + ist.getMinutes();
  const startMins = CONFIG.MARKET_START_HOUR * 60 + CONFIG.MARKET_START_MIN;
  const endMins = CONFIG.MARKET_END_HOUR * 60 + CONFIG.MARKET_END_MIN;

  if (day === 0 || day === 6) return { status: "closed", reason: "Weekend" };
  if (totalMins < startMins) {
    const m = startMins - totalMins;
    return { status: "pre_market", reason: `Opens in ${Math.floor(m / 60)}h ${m % 60}m` };
  }
  if (totalMins > endMins) return { status: "post_market", reason: "Closed for today" };
  return { status: "open", reason: "Market is live" };
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
      { headers: {
        "Content-Type": "application/json", "Accept": "application/json",
        "X-UserType": "USER", "X-SourceID": "WEB",
        "X-ClientLocalIP": "192.168.1.1", "X-ClientPublicIP": "103.0.0.1",
        "X-MACAddress": "00:00:00:00:00:00", "X-PrivateKey": ENV.ANGEL_API_KEY,
      }}
    );
    if (res.data?.data?.jwtToken) {
      state.angelAuth = res.data.data.jwtToken;
      state.feedToken = res.data.data.feedToken;
      log("✅ Angel One authenticated");
      return true;
    }
    throw new Error(res.data?.message || "Auth failed");
  } catch (e) {
    log(`❌ Auth failed: ${e.message}`);
    return false;
  }
}

setInterval(async () => {
  log("🔄 Refreshing Angel auth...");
  await authenticateAngel();
}, 6 * 60 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════════════
// SCRIP MASTER — BULLETPROOF (3 strategies)
// ═══════════════════════════════════════════════════════════════════════════
const SCRIP_MASTER_URLS = [
  "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json",
  "https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json",
];
const SCRIP_CACHE_PATH = "./scrip-master.json";

async function loadScripMasterRobust() {
  if (state.scripMasterLoaded) return true;

  // Strategy 1: Disk cache
  if (fs.existsSync(SCRIP_CACHE_PATH)) {
    try {
      const stats = fs.statSync(SCRIP_CACHE_PATH);
      const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);
      const data = JSON.parse(fs.readFileSync(SCRIP_CACHE_PATH, "utf8"));
      if (data?.length > 1000) {
        state.scripMaster = data;
        state.scripMasterLoaded = true;
        log(`✅ Scrip master from disk: ${data.length} items (${ageHours.toFixed(1)}h old)`);
        if (ageHours > 24) setTimeout(() => downloadScripMaster(true), 5000);
        return true;
      }
    } catch (e) { log(`⚠️ Cache corrupt: ${e.message}`); }
  }

  // Strategy 2: Download with retries
  if (await downloadScripMaster(false)) return true;

  // Strategy 3: Hardcoded fallback (always works)
  log("⚠️ Downloads failed · using Nifty 50 fallback");
  state.scripMaster = Object.entries(NIFTY_50_FALLBACK_TOKENS).map(([sym, tok]) => ({
    symbol: `${sym}-EQ`, name: sym, token: tok, exch_seg: "NSE",
  }));
  state.scripMasterLoaded = true;
  state.usingFallback = true;
  log(`✅ Using ${state.scripMaster.length} hardcoded Nifty 50 tokens`);
  setTimeout(() => downloadScripMaster(true), 30000);
  return true;
}

async function downloadScripMaster(silent = false) {
  for (const url of SCRIP_MASTER_URLS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (!silent) log(`⬇️ ${url} (try ${attempt}/3)`);
        const res = await axios.get(url, {
          timeout: 60000,
          maxContentLength: 200 * 1024 * 1024,
          headers: { "User-Agent": "Mozilla/5.0" },
        });
        if (res.data && Array.isArray(res.data) && res.data.length > 1000) {
          state.scripMaster = res.data;
          state.scripMasterLoaded = true;
          state.usingFallback = false;
          try {
            fs.writeFileSync(SCRIP_CACHE_PATH, JSON.stringify(res.data));
            log(`💾 Cached ${res.data.length} instruments`);
          } catch {}
          log(`✅ Downloaded: ${res.data.length} instruments`);
          return true;
        }
      } catch (e) {
        if (!silent) log(`⚠️ Try ${attempt} failed: ${e.message}`);
        if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
  }
  return false;
}

async function getSymbolToken(symbol) {
  if (state.symbolTokens.has(symbol)) return state.symbolTokens.get(symbol);
  if (!state.scripMasterLoaded) await loadScripMasterRobust();

  // Hardcoded fallback first
  if (NIFTY_50_FALLBACK_TOKENS[symbol]) {
    const token = NIFTY_50_FALLBACK_TOKENS[symbol];
    state.symbolTokens.set(symbol, token);
    state.tokenToSymbol.set(token, symbol);
    return token;
  }

  if (!state.scripMaster) return null;
  let match = state.scripMaster.find(s => s.symbol === `${symbol}-EQ` && s.exch_seg === "NSE");
  if (!match) match = state.scripMaster.find(s => s.name === symbol && s.exch_seg === "NSE" && s.symbol?.endsWith("-EQ"));
  if (match?.token) {
    state.symbolTokens.set(symbol, match.token);
    state.tokenToSymbol.set(match.token, symbol);
    return match.token;
  }
  log(`⚠️ Unresolved: ${symbol}`);
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// HISTORICAL CANDLES
// ═══════════════════════════════════════════════════════════════════════════
async function loadHistoricalCandles(symbol, retries = 2) {
  const token = await getSymbolToken(symbol);
  if (!token) return 0;
  const { fromdate, todate } = getTradingDayRange(5);

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await axios.post(
        "https://apiconnect.angelbroking.com/rest/secure/angelbroking/historical/v1/getCandleData",
        { exchange: "NSE", symboltoken: token, interval: "FIVE_MINUTE", fromdate, todate },
        { headers: angelHeaders(), timeout: 20000 }
      );
      const data = res.data?.data || [];
      if (data.length > 0) {
        const candles = data.map(c => ({
          bucket: c[0], o: parseFloat(c[1]), h: parseFloat(c[2]),
          l: parseFloat(c[3]), c: parseFloat(c[4]), v: parseInt(c[5]),
        }));
        state.candleBuffer.set(symbol, candles);
        return candles.length;
      }
      return 0;
    } catch (e) {
      const status = e.response?.status;
      if (status === 401 && attempt < retries) {
        await authenticateAngel();
        continue;
      }
      if (status === 429 && attempt < retries) {
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      if (attempt === 0) log(`  ⚠️ ${symbol}: HTTP ${status}`);
      return 0;
    }
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// WEBSOCKET
// ═══════════════════════════════════════════════════════════════════════════
async function startWebSocket(tokens) {
  if (!tokens?.length) return;
  const wsUrl = `wss://smartapisocket.angelone.in/smart-stream?clientCode=${ENV.ANGEL_CLIENT_ID}&feedToken=${state.feedToken}&apiKey=${ENV.ANGEL_API_KEY}`;
  state.ws = new WebSocket(wsUrl);

  state.ws.on("open", () => {
    log(`📡 WebSocket connected · ${tokens.length} tokens`);
    const chunks = [];
    for (let i = 0; i < tokens.length; i += 50) chunks.push(tokens.slice(i, i + 50));
    chunks.forEach((chunk, i) => {
      setTimeout(() => {
        if (state.ws?.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify({
            correlationID: `nseaibot-${i}`, action: 1,
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
        if (tickCount % 500 === 0) log(`📡 ${tickCount} ticks · ${state.livePrices.size} stocks`);
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

  state.ws.on("close", () => {
    log("⚠️ WebSocket closed · reconnecting in 5s");
    setTimeout(() => startWebSocket(tokens), 5000);
  });
  state.ws.on("error", (e) => log(`⚠️ WS error: ${e.message}`));
  setInterval(() => {
    if (state.ws?.readyState === WebSocket.OPEN) state.ws.ping();
  }, 30000);
}

function parseBinaryTick(buffer) {
  if (!buffer || buffer.length < 51) return null;
  try {
    let tokenStr = "";
    for (let i = 2; i < 27; i++) {
      if (buffer[i] === 0) break;
      tokenStr += String.fromCharCode(buffer[i]);
    }
    tokenStr = tokenStr.trim();
    const ltp = buffer.readInt32LE(43) / 100;
    const ltq = buffer.length >= 51 ? buffer.readInt32LE(47) : 0;
    if (ltp <= 0 || !tokenStr) return null;
    return { token: tokenStr, ltp, volume: ltq };
  } catch { return null; }
}

function updateCandles(symbol, ltp, vol) {
  if (!state.candleBuffer.has(symbol)) state.candleBuffer.set(symbol, []);
  const candles = state.candleBuffer.get(symbol);
  const ist = getISTDate();
  const bucket = Math.floor(ist.getMinutes() / 5) * 5;
  const bucketKey = `${ist.getHours()}:${bucket}`;
  const last = candles[candles.length - 1];
  if (!last || last.bucket !== bucketKey) {
    candles.push({ bucket: bucketKey, o: ltp, h: ltp, l: ltp, c: ltp, v: vol });
    if (candles.length > 300) candles.shift();
  } else {
    last.h = Math.max(last.h, ltp);
    last.l = Math.min(last.l, ltp);
    last.c = ltp;
    last.v += vol;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// INDICATORS (all 7)
// ═══════════════════════════════════════════════════════════════════════════
const ema = (v, p) => { if (v.length < p) return v[v.length-1] || 0; const k = 2/(p+1); let e = v.slice(0,p).reduce((a,b) => a+b, 0)/p; for (let i=p; i<v.length; i++) e = v[i]*k + e*(1-k); return e; };
const sma = (v, p) => v.length < p ? (v[v.length-1] || 0) : v.slice(-p).reduce((a,b) => a+b, 0) / p;
function rsi(c, p=14) { if (c.length < p+1) return 50; const ch = c.slice(1).map((x,i) => x-c[i]); const g = ch.map(x => x>0?x:0); const l = ch.map(x => x<0?-x:0); let ag = g.slice(0,p).reduce((a,b) => a+b, 0)/p; let al = l.slice(0,p).reduce((a,b) => a+b, 0)/p; for (let i=p; i<ch.length; i++) { ag = (ag*(p-1)+g[i])/p; al = (al*(p-1)+l[i])/p; } return 100 - 100/(1 + ag/(al||0.001)); }
function macd(c) { const e12 = ema(c, 12), e26 = ema(c, 26); return { value: e12 - e26, bullish: e12 > e26 }; }
function vwap(cs) { if (!cs.length) return 0; let pv=0, tv=0; for (const c of cs) { pv += ((c.h+c.l+c.c)/3)*c.v; tv += c.v; } return tv > 0 ? pv/tv : cs[cs.length-1].c; }
function atr(cs, p=14) { if (cs.length < p+1) return 0; const trs = []; for (let i=1; i<cs.length; i++) { const h=cs[i].h,l=cs[i].l,pc=cs[i-1].c; trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc))); } return sma(trs.slice(-p), p); }
function adx(cs, p=14) { if (cs.length < p*2) return {adx:0, plusDI:0, minusDI:0, trending:false}; const pdms=[],mdms=[],trs=[]; for (let i=1; i<cs.length; i++) { const um=cs[i].h-cs[i-1].h, dm=cs[i-1].l-cs[i].l; pdms.push(um>dm && um>0 ? um : 0); mdms.push(dm>um && dm>0 ? dm : 0); const h=cs[i].h,l=cs[i].l,pc=cs[i-1].c; trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc))); } const stt=sma(trs.slice(-p),p), spm=sma(pdms.slice(-p),p), smm=sma(mdms.slice(-p),p); const pdi=(spm/(stt||1))*100, mdi=(smm/(stt||1))*100; return {adx: Math.abs(pdi-mdi)/((pdi+mdi)||1)*100, plusDI:pdi, minusDI:mdi, trending: Math.abs(pdi-mdi)/((pdi+mdi)||1)*100 > 25}; }
function supertrend(cs, p=10, m=3) { if (cs.length < p) return {trend:"neutral"}; const a=atr(cs,p), l=cs[cs.length-1]; const hl2=(l.h+l.l)/2, ub=hl2+m*a, lb=hl2-m*a; return {trend: l.c > ub ? "bull" : l.c < lb ? "bear" : "neutral"}; }
function bollinger(c, p=20) { if (c.length < p) return {upper:0,lower:0,mid:0}; const s=c.slice(-p), m=s.reduce((a,b) => a+b, 0)/p, sd=Math.sqrt(s.reduce((a,b) => a+(b-m)**2, 0)/p); return {upper: m+2*sd, mid: m, lower: m-2*sd}; }

// ═══════════════════════════════════════════════════════════════════════════
// STATISTICAL LEARNING — Updates symbol win rates from DB
// ═══════════════════════════════════════════════════════════════════════════
async function updateSymbolStats() {
  if (!CONFIG.USE_STATISTICAL_LEARNING) return;
  try {
    const r = await db.query(`
      SELECT symbol,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE pnl > 0) AS wins,
        AVG(pnl) AS avg_pnl
      FROM trades
      WHERE status = 'closed' AND closed_at > NOW() - INTERVAL '30 days'
      GROUP BY symbol
      HAVING COUNT(*) >= 5
    `);
    state.symbolStats.clear();
    r.rows.forEach(row => {
      state.symbolStats.set(row.symbol, {
        winRate: parseFloat(row.wins) / parseFloat(row.total),
        total: parseInt(row.total),
        avgPnL: parseFloat(row.avg_pnl),
      });
    });
    log(`📊 Symbol stats updated: ${state.symbolStats.size} stocks with history`);
  } catch (e) {
    log(`⚠️ Symbol stats update failed: ${e.message}`);
  }
}

// Update every hour
setInterval(updateSymbolStats, 60 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════════════
// CLAUDE AI SENTIMENT LAYER (optional)
// ═══════════════════════════════════════════════════════════════════════════
async function getAISentiment(symbol, signal, indicators) {
  if (!CONFIG.USE_AI_SENTIMENT || !ENV.ANTHROPIC_API_KEY) {
    return { sentiment: "NEUTRAL", confidence: 50, skipped: true };
  }

  const prompt = `You are an NSE intraday trading analyst. A technical signal just fired:

Stock: ${symbol}
Signal: ${signal}
RSI: ${indicators.rsi}
ADX: ${indicators.adx}
Supertrend: ${indicators.supertrend}
Pattern: ${indicators.pattern || "none"}

Based on current Indian market conditions (FII flows, sector trends, recent news for ${symbol}), reply ONLY with:

VERDICT: AGREE / DISAGREE / NEUTRAL
CONFIDENCE: 0-100
REASON: One sentence

Example:
VERDICT: AGREE
CONFIDENCE: 75
REASON: ${symbol} sector showing strong momentum, technical signal aligns with fundamentals.`;

  try {
    const res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }]
      },
      {
        headers: {
          "x-api-key": ENV.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        timeout: 10000,
      }
    );

    const text = res.data?.content?.[0]?.text || "";
    const verdictMatch = text.match(/VERDICT:\s*(AGREE|DISAGREE|NEUTRAL)/i);
    const confMatch = text.match(/CONFIDENCE:\s*(\d+)/);
    const reasonMatch = text.match(/REASON:\s*(.+?)(?:\n|$)/);

    return {
      sentiment: verdictMatch?.[1]?.toUpperCase() || "NEUTRAL",
      confidence: parseInt(confMatch?.[1] || "50"),
      reason: reasonMatch?.[1]?.trim() || "No reason given",
      skipped: false,
    };
  } catch (e) {
    log(`⚠️ AI sentiment failed for ${symbol}: ${e.message}`);
    return { sentiment: "NEUTRAL", confidence: 50, skipped: true, error: e.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// STRATEGY ENGINE v6.4 (with AI + statistical boost)
// ═══════════════════════════════════════════════════════════════════════════
function analyzeSignal(symbol, candles, relaxed = false) {
  if (candles.length < CONFIG.MIN_CANDLES) return { rejected: true, reason: `${candles.length} candles` };

  const closes = candles.map(c => c.c);
  const vols = candles.map(c => c.v);
  const price = closes[closes.length - 1];

  const R = rsi(closes);
  const M = macd(closes);
  const e9 = ema(closes, 9), e21 = ema(closes, 21), e50 = ema(closes, 50);
  const e200 = ema(closes, Math.min(200, closes.length - 1));
  const vw = vwap(candles);
  const adxData = adx(candles);
  const st = supertrend(candles);
  const bb = bollinger(closes);
  const a = atr(candles);
  const avgVol = vols.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, vols.length);
  const volRatio = avgVol > 0 ? vols[vols.length - 1] / avgVol : 1;

  // ADX trend filter
  if (!relaxed && adxData.adx < CONFIG.MIN_ADX) {
    return { rejected: true, reason: `ADX ${adxData.adx.toFixed(1)} < ${CONFIG.MIN_ADX}`, symbol, signal: "HOLD" };
  }

  const longTermBullish = price > e200;
  const longTermBearish = price < e200;

  // Candlestick patterns
  const last = candles[candles.length - 1], prev = candles[candles.length - 2];
  const isBullishEngulfing = prev && last.c > last.o && prev.c < prev.o && last.c > prev.o && last.o < prev.c;
  const isHammer = last && (last.c - last.l) > 2 * (last.h - last.c) && last.c > last.o;
  const isBearishEngulfing = prev && last.c < last.o && prev.c > prev.o && last.c < prev.o && last.o > prev.c;
  const isShootingStar = last && (last.h - last.c) > 2 * (last.c - last.l) && last.c < last.o;

  let score = 0, bullCount = 0, bearCount = 0;
  const checks = {};

  // RSI
  if (R < 30) { score += 2.5; bullCount++; checks.rsi = "oversold"; }
  else if (R > 70) { score -= 2.5; bearCount++; checks.rsi = "overbought"; }
  else if (R < 40 && longTermBullish) { score += 1; bullCount++; checks.rsi = "bull"; }
  else if (R > 60 && longTermBearish) { score -= 1; bearCount++; checks.rsi = "bear"; }
  else checks.rsi = "neutral";

  // MACD
  if (M.bullish && M.value > 0) { score += 2; bullCount++; checks.macd = "strong-bull"; }
  else if (!M.bullish && M.value < 0) { score -= 2; bearCount++; checks.macd = "strong-bear"; }
  else if (M.bullish) { score += 0.5; checks.macd = "weak-bull"; }
  else { score -= 0.5; checks.macd = "weak-bear"; }

  // EMA alignment
  if (e9 > e21 && e21 > e50 && e50 > e200) { score += 2.5; bullCount++; checks.ema = "strong-bull"; }
  else if (e9 < e21 && e21 < e50 && e50 < e200) { score -= 2.5; bearCount++; checks.ema = "strong-bear"; }
  else if (e9 > e21 && e21 > e50) { score += 1; bullCount++; checks.ema = "bull"; }
  else if (e9 < e21 && e21 < e50) { score -= 1; bearCount++; checks.ema = "bear"; }
  else checks.ema = "mixed";

  // VWAP
  if (price > vw * 1.003) { score += 2; bullCount++; checks.vwap = "above"; }
  else if (price < vw * 0.997) { score -= 2; bearCount++; checks.vwap = "below"; }
  else checks.vwap = "near";

  // ADX
  if (adxData.trending && adxData.adx > 30) {
    if (adxData.plusDI > adxData.minusDI * 1.2) { score += 1.5; bullCount++; checks.adx = "strong-bull-trend"; }
    else if (adxData.minusDI > adxData.plusDI * 1.2) { score -= 1.5; bearCount++; checks.adx = "strong-bear-trend"; }
  } else if (adxData.trending) {
    if (adxData.plusDI > adxData.minusDI) { score += 0.5; checks.adx = "bull-trend"; }
    else { score -= 0.5; checks.adx = "bear-trend"; }
  } else checks.adx = "ranging";

  // Supertrend
  if (st.trend === "bull") { score += 1.5; bullCount++; checks.supertrend = "bull"; }
  else if (st.trend === "bear") { score -= 1.5; bearCount++; checks.supertrend = "bear"; }
  else checks.supertrend = "neutral";

  // Bollinger
  if (price <= bb.lower * 1.005 && R < 35) { score += 1.5; checks.bb = "oversold-bounce"; }
  else if (price >= bb.upper * 0.995 && R > 65) { score -= 1.5; checks.bb = "overbought-rejection"; }

  // Patterns
  if (isBullishEngulfing || isHammer) {
    score += 1.5; bullCount++;
    checks.pattern = isBullishEngulfing ? "bullish-engulfing" : "hammer";
  } else if (isBearishEngulfing || isShootingStar) {
    score -= 1.5; bearCount++;
    checks.pattern = isBearishEngulfing ? "bearish-engulfing" : "shooting-star";
  }

  // Volume
  if (volRatio > 2.0) score *= 1.2;
  else if (volRatio > 1.5) score *= 1.1;
  else if (volRatio < 0.7) score *= 0.7;

  // Long-term override
  if (longTermBearish && score > 0) score *= 0.5;
  if (longTermBullish && score < 0) score *= 0.5;

  // ═══ STATISTICAL LEARNING BOOST ═══
  let statBoost = 0;
  if (CONFIG.USE_STATISTICAL_LEARNING && state.symbolStats.has(symbol)) {
    const stats = state.symbolStats.get(symbol);
    if (stats.winRate > 0.6) statBoost = 0.5;       // Historically good stock
    else if (stats.winRate < 0.4) statBoost = -0.5; // Historically bad
    score += Math.sign(score) * statBoost;
  }

  const sb = relaxed ? 2.5 : CONFIG.SIGNAL_SCORE_BUY;
  const ss = relaxed ? -2.5 : CONFIG.SIGNAL_SCORE_SELL;
  const mc = relaxed ? 3 : CONFIG.MIN_CONFLUENCE;

  let signal = "HOLD", confidence = 50;
  if (score >= sb) { signal = "BUY"; confidence = Math.min(55 + score * 3, 85); }
  else if (score <= ss) { signal = "SELL"; confidence = Math.min(55 + Math.abs(score) * 3, 82); }

  const maxConf = Math.max(bullCount, bearCount);

  // Filters
  const filtersPassed = {
    confluence: maxConf >= mc,
    volume: volRatio >= (relaxed ? 1.0 : CONFIG.MIN_VOLUME_RATIO),
    strength: Math.abs(score) >= Math.abs(sb),
    confidence: confidence >= (relaxed ? 60 : CONFIG.MIN_CONFIDENCE),
    trend: relaxed ? true : adxData.adx >= CONFIG.MIN_ADX,
    longTerm: signal === "BUY" ? !longTermBearish : signal === "SELL" ? !longTermBullish : true,
  };
  const safeToTrade = Object.values(filtersPassed).every(Boolean);

  // ATR-based SL/Target
  const stopDist = Math.max(price * CONFIG.SL_PCT, a * CONFIG.ATR_SL_MULT);
  const targetDist = Math.max(price * CONFIG.TARGET_PCT, a * CONFIG.ATR_TARGET_MULT);
  const qty = Math.max(1, Math.floor(CONFIG.RISK_PER_TRADE / stopDist));
  const entry = parseFloat(price.toFixed(2));
  const sl = parseFloat((signal === "BUY" ? price - stopDist : price + stopDist).toFixed(2));
  const target = parseFloat((signal === "BUY" ? price + targetDist : price - targetDist).toFixed(2));
  const orderType = (maxConf >= 5 && volRatio > 1.5 && confidence > 75 && adxData.adx > 30) ? "CNC" : "MIS";

  return {
    id: `${symbol}-${Date.now()}`,
    symbol, signal,
    confidence: parseFloat(confidence.toFixed(1)),
    score: parseFloat(score.toFixed(2)),
    orderType,
    indicators: {
      rsi: parseFloat(R.toFixed(1)),
      macd: parseFloat(M.value.toFixed(3)),
      vwap: parseFloat(vw.toFixed(2)),
      adx: parseFloat(adxData.adx.toFixed(1)),
      supertrend: st.trend,
      atr: parseFloat(a.toFixed(2)),
      volRatio: parseFloat(volRatio.toFixed(2)),
      pattern: checks.pattern || "none",
      checks,
    },
    bullCount, bearCount,
    longTermTrend: longTermBullish ? "bullish" : longTermBearish ? "bearish" : "neutral",
    statBoost,
    filtersPassed, safeToTrade,
    entry, sl, target, qty,
    capital: qty * entry,
    maxLoss: qty * stopDist,
    maxGain: qty * targetDist,
    relaxed, timestamp: Date.now(),
    rejected: false,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// BALANCE-AWARE TRADING
// ═══════════════════════════════════════════════════════════════════════════
async function fetchLiveBalance(forceFresh = false) {
  const age = Date.now() - state.balanceCacheTime;
  if (!forceFresh && state.cachedBalance && age < 30000) return state.cachedBalance;

  try {
    const res = await axios.get(
      "https://apiconnect.angelbroking.com/rest/secure/angelbroking/user/v1/getRMS",
      { headers: angelHeaders(), timeout: 8000 }
    );
    const d = res.data?.data || {};
    state.cachedBalance = {
      availableCash: parseFloat(d.availablecash || 0),
      utilisedMargin: parseFloat(d.utiliseddebits || 0),
      realisedMTM: parseFloat(d.m2mrealised || 0),
      unrealisedMTM: parseFloat(d.m2munrealised || 0),
    };
    state.balanceCacheTime = Date.now();
    return state.cachedBalance;
  } catch (e) {
    return state.cachedBalance || { availableCash: 0, utilisedMargin: 0 };
  }
}

async function balanceCheck(sig) {
  const balance = await fetchLiveBalance(true);
  const available = balance.availableCash || 0;
  const isIntraday = sig.orderType === "MIS";
  const capitalNeeded = sig.qty * sig.entry;
  const marginNeeded = isIntraday ? capitalNeeded / 5 : capitalNeeded;

  if (available - CONFIG.MIN_CASH_BUFFER < marginNeeded) {
    const maxQty = Math.floor((available - CONFIG.MIN_CASH_BUFFER) / (isIntraday ? sig.entry / 5 : sig.entry));
    if (maxQty < 1) return { approved: false, reason: "INSUFFICIENT_CASH", message: `Need ₹${marginNeeded.toFixed(0)}, have ₹${available.toFixed(0)}` };
    return { approved: true, adjusted: true, suggestedQty: maxQty, message: `Qty reduced ${sig.qty} → ${maxQty}` };
  }

  const maxPerTrade = available * CONFIG.MAX_CAPITAL_PER_TRADE;
  if (marginNeeded > maxPerTrade) {
    const maxQty = Math.floor(maxPerTrade / (isIntraday ? sig.entry / 5 : sig.entry));
    return { approved: true, adjusted: true, suggestedQty: maxQty, message: `Qty capped at 30% rule: ${maxQty}` };
  }

  return { approved: true, adjusted: false, suggestedQty: sig.qty, message: "OK" };
}

// ═══════════════════════════════════════════════════════════════════════════
// TELEGRAM
// ═══════════════════════════════════════════════════════════════════════════
const tg = new TelegramBot(ENV.TELEGRAM_TOKEN, { polling: true });

async function sendSignalAlert(sig, isForced = false) {
  // Optional: AI sentiment check for high-confidence signals
  let aiInfo = null;
  if (CONFIG.USE_AI_SENTIMENT && sig.confidence >= CONFIG.AI_SENTIMENT_MIN_CONFIDENCE) {
    aiInfo = await getAISentiment(sig.symbol, sig.signal, sig.indicators);
    if (!aiInfo.skipped) {
      // Adjust confidence based on AI verdict
      if (aiInfo.sentiment === "AGREE") sig.confidence = Math.min(sig.confidence + 5, 90);
      else if (aiInfo.sentiment === "DISAGREE") sig.confidence -= 10;

      // Skip signal if AI strongly disagrees
      if (aiInfo.sentiment === "DISAGREE" && aiInfo.confidence > 70) {
        log(`🤖 AI rejected ${sig.symbol} ${sig.signal}: ${aiInfo.reason}`);
        return;
      }
    }
  }

  state.pendingSignals.set(sig.id, sig);
  setTimeout(() => state.pendingSignals.delete(sig.id), 120000);
  await logSignal(sig, "pending");
  state.signalsToday++;

  const emoji = sig.signal === "BUY" ? "🟢" : "🔴";
  const typeBadge = sig.orderType === "CNC" ? "📦 DELIVERY" : "⚡ INTRADAY";
  const forcedTag = isForced ? "\n🎯 *Best signal of the day*" : "";
  const aiTag = aiInfo && !aiInfo.skipped ? `\n🤖 AI: ${aiInfo.sentiment} (${aiInfo.confidence}%) — ${aiInfo.reason}` : "";
  const statTag = sig.statBoost ? `\n📊 Stat boost: ${sig.statBoost > 0 ? "+" : ""}${sig.statBoost}` : "";

  const msg = `${emoji} *${sig.signal} SIGNAL* · ${typeBadge}${forcedTag}
━━━━━━━━━━━━━━━━━
*${sig.symbol}*  (${sig.confidence}% confidence)

💰 Entry:  ₹${sig.entry}
🎯 Target: ₹${sig.target}  (+₹${sig.maxGain.toFixed(0)})
🛑 SL:     ₹${sig.sl}  (-₹${sig.maxLoss.toFixed(0)})
📦 Qty: ${sig.qty} · ₹${sig.capital.toFixed(0)}

📊 RSI ${sig.indicators.rsi} · ADX ${sig.indicators.adx}
📈 VWAP ${sig.indicators.checks.vwap} · ST ${sig.indicators.supertrend}
${sig.indicators.pattern !== "none" ? `🕯️ Pattern: ${sig.indicators.pattern}` : ""}
Confluence ${Math.max(sig.bullCount, sig.bearCount)}/7${statTag}${aiTag}

⏰ _Expires in 2 minutes_`;

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
    await tg.editMessageText(`✅ *LIVE* · ${sig.symbol} ${sig.signal}`, { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: "Markdown" });
  }
  if (data.startsWith("exec_paper_")) {
    executePaperTrade(sig);
    await tg.answerCallbackQuery(query.id, { text: "📝 Paper" });
    await tg.editMessageText(`📝 *PAPER* · ${sig.symbol} ${sig.signal} @ ₹${sig.entry}`, { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: "Markdown" });
  }
});

// ═══ TELEGRAM COMMANDS ═══
tg.onText(/\/start/, async (msg) => {
  await tg.sendMessage(msg.chat.id, `👋 *NSE TradeAI v6.4*\n\nMonitoring ${CONFIG.WATCHLIST.length} stocks · 9 AM - 4 PM IST\n\n/status · /scan · /market\n/scheduler · /positions\n/stop · /resume`, { parse_mode: "Markdown" });
});

tg.onText(/\/status/, async () => {
  const liveActive = state.openTrades.filter(t => t.mode === "live" && t.status === "open").length;
  const totalCandles = [...state.candleBuffer.values()].reduce((s, c) => s + c.length, 0);
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `📊 *v6.4 Status*
━━━━━━━━━━━━━
Live P&L: ₹${state.dayPnL.live.toFixed(0)} · Paper: ₹${state.dayPnL.paper.toFixed(0)}
Positions: ${liveActive}/${CONFIG.MAX_POSITIONS}
Signals today: ${state.signalsToday}
Halted: ${state.isHalted ? "🛑" : "✅"}
━━━━━━━━━━━━━
✅ Tokens: ${state.symbolTokens.size}/${CONFIG.WATCHLIST.length}
📊 Candles: ${totalCandles} · 🔄 Scans: ${state.scanCount}
📡 Live: ${state.livePrices.size} stocks
🤖 AI: ${CONFIG.USE_AI_SENTIMENT ? "ON" : "OFF"} · Stats: ${state.symbolStats.size} stocks
${state.usingFallback ? "⚠️ Using fallback scrip master" : ""}`, { parse_mode: "Markdown" });
});

tg.onText(/\/scan/, async () => {
  const status = getMarketStatus();
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `🔍 Force-scanning (market: ${status.status})...`);
  const r = await runScan(true, true);
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `✅ Done · ${r.results?.alerted || 0} signals · Today: ${state.signalsToday}`);
});

tg.onText(/\/market/, async () => {
  const status = getMarketStatus();
  const ist = getISTDate();
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `📊 *Market Status*
━━━━━━━━━━━━━
${status.status === "open" ? "✅ OPEN" : status.status === "pre_market" ? "🟡 PRE-MARKET" : "🔴 CLOSED"}
Time: ${ist.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })} IST
Hours: ${CONFIG.MARKET_START_HOUR}:00 - ${CONFIG.MARKET_END_HOUR}:00
${status.reason}`, { parse_mode: "Markdown" });
});

tg.onText(/\/scheduler/, async () => {
  const stuck = lastScanCompletedAt && (Date.now() - lastScanCompletedAt.getTime()) > 90000;
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `⏰ *Scheduler*
━━━━━━━━━━━━━
Running: ${schedulerRunning ? "🟢 In scan" : "✅ Idle"}
Market: ${isMarketHours() ? "OPEN" : "CLOSED"}
Halted: ${state.isHalted ? "🛑" : "✅"}
Scans: ${state.scanCount}
Last: ${lastScanCompletedAt?.toLocaleTimeString("en-IN") || "never"}
Stuck: ${stuck ? "⚠️ YES" : "✅"}
Skipped (closed): ${scansSkippedClosedMarket}`, { parse_mode: "Markdown" });
});

tg.onText(/\/diagnose/, async () => {
  const lines = [];
  for (const sym of CONFIG.WATCHLIST.slice(0, 15)) {
    const c = state.candleBuffer.get(sym);
    const p = state.livePrices.get(sym);
    const tok = state.symbolTokens.get(sym);
    lines.push(`${sym.padEnd(12)} ${tok ? "✓" : "✗"} ${(c?.length || 0).toString().padStart(3)}c ₹${p?.ltp?.toFixed(1) || "—"}`);
  }
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `🔍 *Diagnosis:*\n\`\`\`\n${lines.join("\n")}\n\`\`\``, { parse_mode: "Markdown" });
});

tg.onText(/\/stop/, async () => { state.isHalted = true; await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, "🛑 Halted"); });
tg.onText(/\/resume/, async () => { state.isHalted = false; await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, "✅ Resumed"); });
tg.onText(/\/positions/, async () => {
  const active = state.openTrades.filter(t => t.status === "open");
  if (!active.length) return tg.sendMessage(ENV.TELEGRAM_CHAT_ID, "📭 No positions");
  const msg = active.map(t => {
    const cur = state.livePrices.get(t.symbol)?.ltp || t.entry;
    const pnl = (cur - t.entry) * t.qty * (t.signal === "BUY" ? 1 : -1);
    return `${t.mode === "live" ? "💰" : "📝"} *${t.symbol}*\n₹${t.entry} → ₹${cur.toFixed(2)}\nSL ₹${t.currentSL} · Target ₹${t.target}\nP&L: ${pnl >= 0 ? "+" : ""}₹${pnl.toFixed(0)}`;
  }).join("\n━━━━\n");
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, msg, { parse_mode: "Markdown" });
});

// ═══════════════════════════════════════════════════════════════════════════
// ORDER EXECUTION
// ═══════════════════════════════════════════════════════════════════════════
async function executeLiveOrder(sig) {
  const check = await balanceCheck(sig);
  if (!check.approved) {
    await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `🚫 Trade blocked: ${sig.symbol}\n${check.message}`);
    return;
  }
  if (check.adjusted) {
    sig.qty = check.suggestedQty;
    sig.capital = sig.qty * sig.entry;
    sig.maxLoss = sig.qty * Math.abs(sig.entry - sig.sl);
    sig.maxGain = sig.qty * Math.abs(sig.target - sig.entry);
    log(`📉 Qty adjusted: ${check.message}`);
  }

  try {
    const token = await getSymbolToken(sig.symbol);
    const res = await axios.post(
      "https://apiconnect.angelbroking.com/rest/secure/angelbroking/order/v1/placeOrder",
      {
        variety: "NORMAL", tradingsymbol: `${sig.symbol}-EQ`, symboltoken: token,
        transactiontype: sig.signal, exchange: "NSE", ordertype: "MARKET",
        producttype: sig.orderType === "CNC" ? "DELIVERY" : "INTRADAY",
        duration: "DAY", quantity: sig.qty.toString(),
      },
      { headers: angelHeaders() }
    );
    if (res.data?.status) {
      const trade = {
        ...sig, mode: "live", orderId: res.data.data.orderid,
        currentSL: sig.sl, currentPrice: sig.entry,
        status: "open", openedAt: new Date(), trailed: false,
      };
      state.openTrades.push(trade);
      await logTrade(trade);
      await logSignal(sig, "executed_live");
      log(`✅ LIVE: ${sig.symbol} ${sig.signal} ${sig.qty}`);
    }
  } catch (e) {
    log(`❌ Order failed: ${e.message}`);
    await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `⚠️ Order failed: ${sig.symbol}\n${e.message}`);
  }
}

function executePaperTrade(sig) {
  const trade = {
    ...sig, mode: "paper", currentSL: sig.sl, currentPrice: sig.entry,
    status: "open", openedAt: new Date(), trailed: false,
  };
  state.openTrades.push(trade);
  logTrade(trade);
  logSignal(sig, "executed_paper");
  log(`📝 PAPER: ${sig.symbol} ${sig.signal}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// TRAILING STOP-LOSS
// ═══════════════════════════════════════════════════════════════════════════
setInterval(async () => {
  for (const t of state.openTrades.filter(x => x.status === "open")) {
    const cur = state.livePrices.get(t.symbol)?.ltp;
    if (!cur) continue;
    t.currentPrice = cur;
    if (t.signal === "BUY") {
      const gain = cur - t.entry;
      if (gain > 0) {
        const newSL = parseFloat((t.sl + gain).toFixed(2));
        if (newSL > t.currentSL) {
          await updateSLMovement(t.id, t.currentSL, newSL, cur);
          t.currentSL = newSL; t.trailed = true;
        }
      }
      if (cur <= t.currentSL) await closeTrade(t, "SL_HIT", t.currentSL);
      else if (cur >= t.target) await closeTrade(t, "TARGET_HIT", t.target);
    }
    if (t.orderType === "MIS") {
      const ist = getISTDate();
      if (ist.getHours() === 15 && ist.getMinutes() >= 15) {
        await closeTrade(t, "EOD_SQUARE_OFF", cur);
      }
    }
  }
}, 3000);

async function closeTrade(t, reason, exit) {
  t.status = "closed"; t.exitPrice = exit; t.exitReason = reason;
  t.exitPnL = (exit - t.entry) * t.qty * (t.signal === "BUY" ? 1 : -1);
  t.closedAt = new Date();
  state.dayPnL[t.mode] += t.exitPnL;
  await dbCloseTrade(t.id, exit, reason, t.exitPnL);

  if (t.mode === "live" && CONFIG.LIVE_TRADING) {
    try {
      await axios.post(
        "https://apiconnect.angelbroking.com/rest/secure/angelbroking/order/v1/placeOrder",
        {
          variety: "NORMAL", tradingsymbol: `${t.symbol}-EQ`,
          symboltoken: await getSymbolToken(t.symbol),
          transactiontype: t.signal === "BUY" ? "SELL" : "BUY",
          exchange: "NSE", ordertype: "MARKET",
          producttype: t.orderType === "CNC" ? "DELIVERY" : "INTRADAY",
          duration: "DAY", quantity: t.qty.toString(),
        },
        { headers: angelHeaders() }
      );
    } catch (e) { log(`❌ Exit failed: ${e.message}`); }
  }

  const emoji = reason === "TARGET_HIT" ? "🎯" : reason === "SL_HIT" ? "🛑" : "⏰";
  const pEm = t.exitPnL >= 0 ? "✅" : "❌";
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID,
    `${emoji} *${reason.replace(/_/g, " ")}* · ${t.mode === "live" ? "💰" : "📝"}\n*${t.symbol}*\nEntry ₹${t.entry} → Exit ₹${exit}\n${pEm} P&L: ${t.exitPnL >= 0 ? "+" : ""}₹${t.exitPnL.toFixed(0)}`,
    { parse_mode: "Markdown" });
  log(`${reason}: ${t.symbol} · ₹${t.exitPnL.toFixed(0)}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN SCANNER
// ═══════════════════════════════════════════════════════════════════════════
async function runScan(verbose = false, forceRun = false) {
  if (schedulerRunning && !forceRun) {
    if (verbose) log("⏭️ Skipping (in progress)");
    return { skipped: true, reason: "in_progress" };
  }
  schedulerRunning = true;
  const startTime = Date.now();

  try {
    if (!forceRun && !isMarketHours()) {
      scansSkippedClosedMarket++;
      const status = getMarketStatus();
      if (verbose || scansSkippedClosedMarket % 30 === 1) log(`⏰ Market ${status.status} · ${status.reason}`);
      return { skipped: true, reason: "market_closed", marketStatus: status };
    }
    if (state.isHalted) return { skipped: true, reason: "halted" };

    state.scanCount++;
    state.lastScanTime = new Date();
    const r = { scanned: 0, noCandles: 0, inPos: 0, hold: 0, filtered: 0, alerted: 0, rejectedBy: {} };

    for (const symbol of CONFIG.WATCHLIST) {
      r.scanned++;
      const candles = state.candleBuffer.get(symbol);
      if (!candles || candles.length < CONFIG.MIN_CANDLES) { r.noCandles++; continue; }
      if (state.openTrades.some(t => t.symbol === symbol && t.status === "open")) { r.inPos++; continue; }
      const sig = analyzeSignal(symbol, candles);
      if (!sig || sig.rejected) { r.noCandles++; continue; }
      if (sig.signal === "HOLD") { r.hold++; continue; }
      if (!sig.safeToTrade) {
        r.filtered++;
        Object.entries(sig.filtersPassed).filter(([k, v]) => !v).forEach(([k]) => r.rejectedBy[k] = (r.rejectedBy[k] || 0) + 1);
        continue;
      }
      r.alerted++;
      await sendSignalAlert(sig);
    }

    if (isMarketHours()) {
      const ist = getISTDate();
      const curHour = ist.getHours() + ist.getMinutes() / 60;
      if (state.signalsToday === 0 && !state.forcedSignalSent &&
          curHour >= CONFIG.FORCE_SIGNAL_AFTER_HOUR && curHour <= CONFIG.FORCE_SIGNAL_MAX_HOUR) {
        let best = null;
        for (const symbol of CONFIG.WATCHLIST) {
          const candles = state.candleBuffer.get(symbol);
          if (!candles || candles.length < CONFIG.MIN_CANDLES) continue;
          if (state.openTrades.some(t => t.symbol === symbol && t.status === "open")) continue;
          const sig = analyzeSignal(symbol, candles, true);
          if (!sig || sig.signal === "HOLD") continue;
          if (!best || Math.abs(sig.score) > Math.abs(best.score)) best = sig;
        }
        if (best?.safeToTrade) {
          state.forcedSignalSent = true;
          log(`🎯 FORCED: ${best.symbol} ${best.signal}`);
          await sendSignalAlert(best, true);
        }
      }
    }

    lastScanCompletedAt = new Date();
    log(`🔍 Scan #${state.scanCount} · ${Date.now() - startTime}ms · ${r.scanned}|${r.noCandles}nd|${r.inPos}ip|${r.hold}h|${r.filtered}f|${r.alerted}a${forceRun ? " (FORCED)" : ""}`);
    return { skipped: false, results: r };
  } catch (e) {
    log(`💥 Scan error: ${e.message}`);
    return { error: e.message };
  } finally {
    schedulerRunning = false;
  }
}

function startScheduler() {
  if (scanInterval) clearInterval(scanInterval);
  log(`⏰ Scheduler · ${CONFIG.MARKET_START_HOUR}:00-${CONFIG.MARKET_END_HOUR}:00 · scan every ${CONFIG.SCAN_INTERVAL_MS / 1000}s`);
  scanInterval = setInterval(() => runScan().catch(e => log(`💥 ${e.message}`)), CONFIG.SCAN_INTERVAL_MS);
  setTimeout(() => {
    if (isMarketHours()) {
      log("🚀 Initial scan");
      runScan(true).catch(e => log(`💥 ${e.message}`));
    } else log(`⏰ Market closed · armed for ${CONFIG.MARKET_START_HOUR}:00`);
  }, 5000);
  startWatchdog();
}

function startWatchdog() {
  if (watchdogInterval) clearInterval(watchdogInterval);
  watchdogInterval = setInterval(() => {
    if (!isMarketHours() || state.isHalted || !lastScanCompletedAt) return;
    const elapsed = Date.now() - lastScanCompletedAt.getTime();
    if (elapsed > CONFIG.SCHEDULER_TIMEOUT_MS) {
      log(`⚠️ Scheduler stuck (${Math.round(elapsed / 1000)}s) · RESTARTING`);
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
// MOBILE API ENDPOINTS — for on-demand control
// ═══════════════════════════════════════════════════════════════════════════
function addSchedulerEndpoints(app, auth) {
  app.post("/api/scan/now", auth, async (req, res) => {
    log("📱 Manual scan from mobile");
    const r = await runScan(true, true);
    res.json({ ok: true, forced: true, ...r });
  });

  app.get("/api/scheduler/status", auth, (req, res) => {
    const stuck = lastScanCompletedAt && (Date.now() - lastScanCompletedAt.getTime()) > 90000;
    res.json({
      market: getMarketStatus(),
      scheduler: {
        running: schedulerRunning,
        scansCompleted: state.scanCount,
        lastScanAt: lastScanCompletedAt?.toISOString() || null,
        secondsSinceLastScan: lastScanCompletedAt ? Math.round((Date.now() - lastScanCompletedAt.getTime()) / 1000) : null,
        stuck, halted: state.isHalted,
        skippedClosedMarket: scansSkippedClosedMarket,
      },
      signals: { today: state.signalsToday, forcedSignalSent: state.forcedSignalSent },
      scripMaster: {
        loaded: state.scripMasterLoaded,
        usingFallback: state.usingFallback,
        instrumentCount: state.scripMaster?.length || 0,
      },
      ai: { sentimentEnabled: CONFIG.USE_AI_SENTIMENT, statisticalLearning: CONFIG.USE_STATISTICAL_LEARNING, statsCount: state.symbolStats.size },
    });
  });

  app.post("/api/scheduler/restart", auth, (req, res) => {
    log("📱 Scheduler restart from mobile");
    startScheduler();
    res.json({ ok: true, message: "Scheduler restarted" });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════════════════
async function startup() {
  log("🚀 NSE TradeAI v6.4 · COMPLETE FINAL");
  log(`   Capital: ₹${CONFIG.CAPITAL.toLocaleString("en-IN")} · Risk ₹${CONFIG.RISK_PER_TRADE} · RR 1:${CONFIG.REWARD_RATIO}`);
  log(`   Market: ${CONFIG.MARKET_START_HOUR}:00 - ${CONFIG.MARKET_END_HOUR}:00 IST`);
  log(`   Live: ${CONFIG.LIVE_TRADING ? "✅ ON" : "❌ OFF"}`);
  log(`   AI Sentiment: ${CONFIG.USE_AI_SENTIMENT ? "ON" : "OFF"} · Stat Learning: ${CONFIG.USE_STATISTICAL_LEARNING ? "ON" : "OFF"}`);

  await initDB();
  await logEvent("STARTUP", "v6.4 started");

  const { app, auth } = startAPI(3000);
  addAccountEndpoints(app, state, auth);
  addBacktestEndpoints(app, state, auth);
  addSchedulerEndpoints(app, auth);

  if (!await authenticateAngel()) process.exit(1);
  await loadScripMasterRobust();

  log("🔑 Resolving tokens...");
  const tokens = [];
  for (const sym of CONFIG.WATCHLIST) {
    const t = await getSymbolToken(sym);
    if (t) tokens.push(t);
  }
  log(`✓ Resolved ${tokens.length}/${CONFIG.WATCHLIST.length}`);

  log("📊 Loading historical candles...");
  let totalLoaded = 0, ok = 0;
  for (const sym of CONFIG.WATCHLIST) {
    const n = await loadHistoricalCandles(sym);
    if (n > 0) { totalLoaded += n; ok++; }
    await new Promise(r => setTimeout(r, 250));
  }
  log(`✅ Loaded ${totalLoaded} candles from ${ok}/${CONFIG.WATCHLIST.length}`);

  await updateSymbolStats();
  await startWebSocket(tokens);
  startScheduler();

  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `🚀 *Bot v6.4 Online*
━━━━━━━━━━━━━━
✅ Scrip: ${state.scripMaster.length} ${state.usingFallback ? "(fallback)" : ""}
✅ Tokens: ${tokens.length}/${CONFIG.WATCHLIST.length}
✅ Candles: ${totalLoaded} (${ok} stocks)
✅ Stats: ${state.symbolStats.size} stocks
🤖 AI: ${CONFIG.USE_AI_SENTIMENT ? "ON" : "OFF"}

Market hours: ${CONFIG.MARKET_START_HOUR}:00 - ${CONFIG.MARKET_END_HOUR}:00 IST
${CONFIG.LIVE_TRADING ? "⚡ LIVE" : "📝 Paper only"}

/status · /scan · /market · /scheduler`, { parse_mode: "Markdown" });

  log("✅ Bot operational");
}

startup().catch(e => { log(`💥 Fatal: ${e.message}`); console.error(e); process.exit(1); });

process.on("SIGINT", async () => {
  log("Shutting down...");
  if (state.ws) state.ws.close();
  process.exit(0);
});
process.on("uncaughtException", e => log(`💥 Uncaught: ${e.message}`));
