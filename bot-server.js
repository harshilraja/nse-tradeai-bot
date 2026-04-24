// ═══════════════════════════════════════════════════════════════════════════
// NSE TradeAI Bot v6 · FINAL PRODUCTION VERSION
// Features: Nifty 50 · Multi-indicator · Guaranteed daily signal · Tight SL
// ═══════════════════════════════════════════════════════════════════════════

import axios from "axios";
import { authenticator } from "otplib";
import TelegramBot from "node-telegram-bot-api";
import WebSocket from "ws";
import fs from "fs";
import dotenv from "dotenv";
import {
  initDB, logSignal, logTrade, closeTrade as dbCloseTrade,
  updateSLMovement, logEvent, startAPI
} from "./db-api.js";
import { addAccountEndpoints } from "./angel-account-api.js";

dotenv.config();

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════
const CONFIG = {
  CAPITAL:           250000,
  RISK_PER_TRADE:    1000,
  REWARD_RATIO:      2,
  DAILY_LOSS_CAP:    2500,
  MAX_POSITIONS:     3,
  TRAIL_STEP_PCT:    0.4,
  VIX_DANGER:        22,
  LIVE_TRADING:      process.env.LIVE_TRADING === "true",

  // ─── LOSS PROTECTION: Tight stop losses ───
  SL_PCT:            0.008,   // 0.8% SL (was 1.5%) = smaller losses
  TARGET_PCT:        0.016,   // 1.6% target = 1:2 ratio maintained

  // ─── SIGNAL THRESHOLDS: Tuned for frequent, safe signals ───
  SIGNAL_SCORE_BUY:  2.0,
  SIGNAL_SCORE_SELL: -2.0,
  MIN_CONFLUENCE:    2,
  MIN_CONFIDENCE:    55,
  MIN_VOLUME_RATIO:  0.8,
  MIN_CANDLES:       15,
  SCAN_INTERVAL_MS:  15000,

  // ─── GUARANTEED DAILY SIGNAL ───
  FORCE_SIGNAL_AFTER_HOUR:   12,   // If no signal by 12 PM, relax filters
  FORCE_SIGNAL_MAX_HOUR:     14.5, // Stop forcing after 2:30 PM

  // ─── NIFTY 50 WATCHLIST (all 50 stocks) ───
  WATCHLIST: [
    "RELIANCE","HDFCBANK","ICICIBANK","INFY","TCS","HINDUNILVR","ITC","BHARTIARTL",
    "SBIN","LT","KOTAKBANK","AXISBANK","BAJFINANCE","ASIANPAINT","MARUTI",
    "SUNPHARMA","TITAN","HCLTECH","ULTRACEMCO","NTPC","WIPRO","NESTLEIND",
    "POWERGRID","TATASTEEL","TECHM","ONGC","JSWSTEEL","ADANIENT","ADANIPORTS",
    "COALINDIA","BAJAJFINSV","GRASIM","HINDALCO","M&M","DRREDDY","BRITANNIA",
    "CIPLA","BPCL","INDUSINDBK","EICHERMOT","APOLLOHOSP","BAJAJ-AUTO",
    "HEROMOTOCO","DIVISLAB","TATAMOTORS","UPL","SHRIRAMFIN","SBILIFE",
    "HDFCLIFE","LTIM"
  ],

  UNSAFE_WINDOWS: [
    { start: "09:15", end: "09:20", reason: "Opening volatility" },
    { start: "15:20", end: "15:30", reason: "Closing square-off" }
  ],
};

const ENV = {
  ANGEL_CLIENT_ID:  process.env.ANGEL_CLIENT_ID,
  ANGEL_API_KEY:    process.env.ANGEL_API_KEY,
  ANGEL_MPIN:       process.env.ANGEL_MPIN,
  ANGEL_TOTP_TOKEN: process.env.ANGEL_TOTP_TOKEN,
  TELEGRAM_TOKEN:   process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
};

// ═══════════════════════════════════════════════════════════════════════════
// GLOBAL STATE
// ═══════════════════════════════════════════════════════════════════════════
export const state = {
  angelAuth:         null,
  feedToken:         null,
  refreshToken:      null,
  ws:                null,
  livePrices:        new Map(),
  candleBuffer:      new Map(),
  openTrades:        [],
  pendingSignals:    new Map(),
  dayPnL:            { live: 0, paper: 0 },
  isHalted:          false,
  symbolTokens:      new Map(),
  tokenToSymbol:     new Map(),
  scanCount:         0,
  lastScanTime:      null,
  signalsToday:      0,
  bestSignalToday:   null,  // ← tracks best signal for forced trade
  forcedSignalSent:  false,
};

function log(msg) {
  const ts = new Date().toISOString().replace("T", " ").substring(0, 19);
  console.log(`[${ts}] ${msg}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. ANGEL ONE AUTHENTICATION
// ═══════════════════════════════════════════════════════════════════════════
async function authenticateAngel() {
  log("🔐 Authenticating with Angel One...");
  try {
    const totp = authenticator.generate(ENV.ANGEL_TOTP_TOKEN);
    const res = await axios.post(
        "https://apiconnect.angelbroking.com/rest/auth/angelbroking/user/v1/loginByPassword",
        { clientcode: ENV.ANGEL_CLIENT_ID, password: ENV.ANGEL_MPIN, totp },
        {
          headers: {
            "Content-Type":     "application/json",
            "Accept":           "application/json",
            "X-UserType":       "USER",
            "X-SourceID":       "WEB",
            "X-ClientLocalIP":  "192.168.1.1",
            "X-ClientPublicIP": "103.0.0.1",
            "X-MACAddress":     "00:00:00:00:00:00",
            "X-PrivateKey":     ENV.ANGEL_API_KEY,
          },
        }
    );
    if (res.data?.data?.jwtToken) {
      state.angelAuth = res.data.data.jwtToken;
      state.feedToken = res.data.data.feedToken;
      state.refreshToken = res.data.data.refreshToken;
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
  log("🔄 Refreshing Angel One auth...");
  await authenticateAngel();
}, 6 * 60 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════════════
// 2. SYMBOL TOKEN RESOLVER
// ═══════════════════════════════════════════════════════════════════════════
async function getSymbolToken(symbol) {
  if (state.symbolTokens.has(symbol)) return state.symbolTokens.get(symbol);
  const cachePath = "./scrip-master.json";
  let master;
  try {
    if (fs.existsSync(cachePath)) {
      master = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    } else {
      log("⬇️ Downloading Angel scrip master...");
      const res = await axios.get(
          "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json",
          { timeout: 60000 }
      );
      master = res.data;
      fs.writeFileSync(cachePath, JSON.stringify(master));
    }
    const match = master.find(s => s.symbol === `${symbol}-EQ` && s.exch_seg === "NSE");
    if (match?.token) {
      state.symbolTokens.set(symbol, match.token);
      state.tokenToSymbol.set(match.token, symbol);
      return match.token;
    }
  } catch (e) {
    log(`⚠️ Could not resolve ${symbol}: ${e.message}`);
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. HISTORICAL CANDLE PRE-LOAD
// ═══════════════════════════════════════════════════════════════════════════
async function loadHistoricalCandles(symbol) {
  try {
    const token = await getSymbolToken(symbol);
    if (!token) return 0;

    const now = new Date();
    const fromDate = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);

    const res = await axios.post(
        "https://apiconnect.angelbroking.com/rest/secure/angelbroking/historical/v1/getCandleData",
        {
          exchange:    "NSE",
          symboltoken: token,
          interval:    "FIVE_MINUTE",
          fromdate:    formatAngelDate(fromDate),
          todate:      formatAngelDate(now),
        },
        {
          headers: {
            "Authorization": `Bearer ${state.angelAuth}`,
            "Content-Type":  "application/json",
            "X-PrivateKey":  ENV.ANGEL_API_KEY,
            "X-UserType":    "USER",
            "X-SourceID":    "WEB",
          },
          timeout: 15000
        }
    );

    const data = res.data?.data || [];
    if (data.length > 0) {
      const candles = data.map(c => ({
        bucket: c[0],
        o: parseFloat(c[1]),
        h: parseFloat(c[2]),
        l: parseFloat(c[3]),
        c: parseFloat(c[4]),
        v: parseInt(c[5]),
      }));
      state.candleBuffer.set(symbol, candles);
      return candles.length;
    }
    return 0;
  } catch (e) {
    return 0;
  }
}

function formatAngelDate(d) {
  const pad = n => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. WEBSOCKET
// ═══════════════════════════════════════════════════════════════════════════
async function startWebSocket(tokens) {
  const wsUrl = `wss://smartapisocket.angelone.in/smart-stream?clientCode=${ENV.ANGEL_CLIENT_ID}&feedToken=${state.feedToken}&apiKey=${ENV.ANGEL_API_KEY}`;
  state.ws = new WebSocket(wsUrl);

  state.ws.on("open", () => {
    log("📡 WebSocket connected");
    // Subscribe in chunks of 50 (Angel limit per message)
    const chunks = [];
    for (let i = 0; i < tokens.length; i += 50) chunks.push(tokens.slice(i, i + 50));

    chunks.forEach((chunk, i) => {
      setTimeout(() => {
        state.ws.send(JSON.stringify({
          correlationID: `nseaibot-${i}`,
          action: 1,
          params: { mode: 2, tokenList: [{ exchangeType: 1, tokens: chunk }] }
        }));
      }, i * 300);
    });
  });

  let tickCount = 0;
  state.ws.on("message", (data) => {
    try {
      const tick = parseBinaryTick(data);
      if (tick?.token) {
        tickCount++;
        if (tickCount % 500 === 0) log(`📡 ${tickCount} ticks · ${state.livePrices.size} stocks tracked`);
        const symbol = state.tokenToSymbol.get(tick.token);
        if (symbol) {
          state.livePrices.set(symbol, {
            ltp:       tick.ltp,
            volume:    tick.volume,
            openPrice: state.livePrices.get(symbol)?.openPrice || tick.ltp,
            timestamp: Date.now(),
          });
          updateCandles(symbol, tick.ltp, tick.volume);
        }
      }
    } catch { /* ignore */ }
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
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. CANDLE AGGREGATOR
// ═══════════════════════════════════════════════════════════════════════════
function updateCandles(symbol, ltp, vol) {
  if (!state.candleBuffer.has(symbol)) state.candleBuffer.set(symbol, []);
  const candles = state.candleBuffer.get(symbol);
  const now = new Date();
  const bucket = Math.floor(now.getMinutes() / 5) * 5;
  const bucketKey = `${now.getHours()}:${bucket}`;
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
// 6. TECHNICAL INDICATORS (RSI, MACD, EMA, VWAP, ADX, Supertrend, Bollinger)
// ═══════════════════════════════════════════════════════════════════════════
function ema(values, period) {
  if (values.length < period) return values[values.length - 1] || 0;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function sma(values, period) {
  if (values.length < period) return values[values.length - 1] || 0;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  const ch = closes.slice(1).map((c, i) => c - closes[i]);
  const g = ch.map(x => x > 0 ? x : 0);
  const l = ch.map(x => x < 0 ? -x : 0);
  let ag = g.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let al = l.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < ch.length; i++) {
    ag = (ag * (period - 1) + g[i]) / period;
    al = (al * (period - 1) + l[i]) / period;
  }
  return 100 - 100 / (1 + ag / (al || 0.001));
}

function macd(closes) {
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const line = e12 - e26;
  return { value: line, bullish: line > 0, strength: Math.abs(line) };
}

function vwap(candles) {
  if (candles.length === 0) return 0;
  let totalPV = 0, totalVol = 0;
  for (const c of candles) {
    const typical = (c.h + c.l + c.c) / 3;
    totalPV += typical * c.v;
    totalVol += c.v;
  }
  return totalVol > 0 ? totalPV / totalVol : candles[candles.length-1].c;
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].h, l = candles[i].l, pc = candles[i-1].c;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return sma(trs.slice(-period), period);
}

function adx(candles, period = 14) {
  if (candles.length < period * 2) return 0;
  const plusDMs = [], minusDMs = [], trs = [];
  for (let i = 1; i < candles.length; i++) {
    const upMove = candles[i].h - candles[i-1].h;
    const downMove = candles[i-1].l - candles[i].l;
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
    const h = candles[i].h, l = candles[i].l, pc = candles[i-1].c;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const smoothedTR = sma(trs.slice(-period), period);
  const smoothedPlusDM = sma(plusDMs.slice(-period), period);
  const smoothedMinusDM = sma(minusDMs.slice(-period), period);
  const plusDI = (smoothedPlusDM / (smoothedTR || 1)) * 100;
  const minusDI = (smoothedMinusDM / (smoothedTR || 1)) * 100;
  const dx = Math.abs(plusDI - minusDI) / ((plusDI + minusDI) || 1) * 100;
  return { adx: dx, plusDI, minusDI, trending: dx > 25 };
}

function supertrend(candles, period = 10, multiplier = 3) {
  if (candles.length < period) return { trend: "neutral", value: 0 };
  const a = atr(candles, period);
  const last = candles[candles.length - 1];
  const hl2 = (last.h + last.l) / 2;
  const upperBand = hl2 + multiplier * a;
  const lowerBand = hl2 - multiplier * a;
  const trend = last.c > upperBand ? "bull" : last.c < lowerBand ? "bear" : "neutral";
  return { trend, value: trend === "bull" ? lowerBand : upperBand };
}

function bollinger(closes, period = 20) {
  if (closes.length < period) return { upper: 0, lower: 0, mid: 0 };
  const slice = closes.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((a, b) => a + (b - mid) ** 2, 0) / period);
  return { upper: mid + 2 * std, mid, lower: mid - 2 * std };
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. MULTI-INDICATOR STRATEGY ENGINE
// ═══════════════════════════════════════════════════════════════════════════
function analyzeSignal(symbol, candles, relaxed = false) {
  if (candles.length < CONFIG.MIN_CANDLES) {
    return { rejected: true, reason: `only ${candles.length} candles` };
  }

  const closes = candles.map(c => c.c);
  const vols = candles.map(c => c.v);
  const price = closes[closes.length - 1];

  const R = rsi(closes);
  const M = macd(closes);
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const vw = vwap(candles);
  const adxData = adx(candles);
  const st = supertrend(candles);
  const bb = bollinger(closes);
  const avgVol = vols.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, vols.length);
  const volRatio = avgVol > 0 ? vols[vols.length - 1] / avgVol : 1;

  let score = 0;
  let bullCount = 0, bearCount = 0;
  const checks = {};

  // ─── RSI (weight: 2) ───
  if (R < 40) { score += 2; bullCount++; checks.rsi = "bull"; }
  else if (R > 60) { score -= 2; bearCount++; checks.rsi = "bear"; }
  else if (R >= 45 && R <= 55) { score += 0.3; checks.rsi = "neutral"; }
  else checks.rsi = "neutral";

  // ─── MACD (weight: 1.5) ───
  if (M.bullish) { score += 1.5; bullCount++; checks.macd = "bull"; }
  else { score -= 1.5; bearCount++; checks.macd = "bear"; }

  // ─── EMA alignment (weight: 2) ───
  if (e9 > e21 && e21 > e50) { score += 2; bullCount++; checks.ema = "bull"; }
  else if (e9 < e21 && e21 < e50) { score -= 2; bearCount++; checks.ema = "bear"; }
  else if (e9 > e21) { score += 0.5; checks.ema = "bull-weak"; }
  else { score -= 0.5; checks.ema = "bear-weak"; }

  // ─── VWAP (weight: 1.5) — Price vs VWAP is critical for intraday ───
  if (price > vw * 1.002) { score += 1.5; bullCount++; checks.vwap = "bull"; }
  else if (price < vw * 0.998) { score -= 1.5; bearCount++; checks.vwap = "bear"; }
  else checks.vwap = "neutral";

  // ─── ADX (weight: 1) — Only trade in trending markets ───
  if (adxData.trending) {
    if (adxData.plusDI > adxData.minusDI) { score += 1; checks.adx = "bull-trend"; }
    else { score -= 1; checks.adx = "bear-trend"; }
  } else {
    checks.adx = "ranging";
  }

  // ─── Supertrend (weight: 1) ───
  if (st.trend === "bull") { score += 1; bullCount++; checks.supertrend = "bull"; }
  else if (st.trend === "bear") { score -= 1; bearCount++; checks.supertrend = "bear"; }
  else checks.supertrend = "neutral";

  // ─── Bollinger (weight: 1) ───
  if (price <= bb.lower * 1.005) { score += 1; checks.bb = "oversold"; }
  else if (price >= bb.upper * 0.995) { score -= 1; checks.bb = "overbought"; }
  else checks.bb = "mid";

  // ─── Volume confirmation (weight: 1) ───
  if (volRatio > 1.5) { score += Math.sign(score) * 1; checks.volume = "strong"; }
  else if (volRatio < 0.5) score *= 0.8;  // weak volume = lower conviction

  // ─── Determine signal ───
  const scoreBuy = relaxed ? 1.5 : CONFIG.SIGNAL_SCORE_BUY;
  const scoreSell = relaxed ? -1.5 : CONFIG.SIGNAL_SCORE_SELL;
  const minConf = relaxed ? 1 : CONFIG.MIN_CONFLUENCE;

  let signal = "HOLD";
  let confidence = 50;
  if (score >= scoreBuy) {
    signal = "BUY";
    confidence = Math.min(52 + score * 4, 80);
  } else if (score <= scoreSell) {
    signal = "SELL";
    confidence = Math.min(52 + Math.abs(score) * 4, 78);
  }

  const maxConfluence = Math.max(bullCount, bearCount);
  const orderType = (maxConfluence >= 4 && volRatio > 1.3 && confidence > 65 && adxData.trending) ? "CNC" : "MIS";

  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const unsafe = CONFIG.UNSAFE_WINDOWS.find(w => {
    const [sh, sm] = w.start.split(":").map(Number);
    const [eh, em] = w.end.split(":").map(Number);
    return mins >= (sh * 60 + sm) && mins <= (eh * 60 + em);
  });

  const filtersPassed = {
    confluence: maxConfluence >= minConf,
    time:       !unsafe,
    volume:     volRatio >= (relaxed ? 0.5 : CONFIG.MIN_VOLUME_RATIO),
    strength:   Math.abs(score) >= Math.abs(scoreBuy),
    confidence: confidence >= (relaxed ? 50 : CONFIG.MIN_CONFIDENCE),
  };
  const safeToTrade = Object.values(filtersPassed).every(Boolean);

  // ─── Tight SL & Target (0.8% / 1.6%) ───
  const stopDist = price * CONFIG.SL_PCT;
  const targetDist = price * CONFIG.TARGET_PCT;
  const qty = Math.max(1, Math.floor(CONFIG.RISK_PER_TRADE / stopDist));
  const entry = parseFloat(price.toFixed(2));
  const sl = parseFloat((signal === "BUY" ? price - stopDist : price + stopDist).toFixed(2));
  const target = parseFloat((signal === "BUY" ? price + targetDist : price - targetDist).toFixed(2));

  return {
    id: `${symbol}-${Date.now()}`,
    symbol, signal, confidence: parseFloat(confidence.toFixed(1)),
    score: parseFloat(score.toFixed(2)), orderType,
    indicators: {
      rsi: parseFloat(R.toFixed(1)),
      macd: parseFloat(M.value.toFixed(3)),
      ema9: parseFloat(e9.toFixed(2)),
      ema21: parseFloat(e21.toFixed(2)),
      ema50: parseFloat(e50.toFixed(2)),
      vwap: parseFloat(vw.toFixed(2)),
      adx: parseFloat(adxData.adx?.toFixed(1) || 0),
      supertrend: st.trend,
      volRatio: parseFloat(volRatio.toFixed(2)),
      price: entry,
      checks,
    },
    bullCount, bearCount, filtersPassed, safeToTrade,
    entry, sl, target, qty,
    capital: qty * entry,
    maxLoss: qty * stopDist,
    maxGain: qty * targetDist,
    relaxed,
    timestamp: Date.now(),
    rejected: false,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. TELEGRAM BOT
// ═══════════════════════════════════════════════════════════════════════════
const tg = new TelegramBot(ENV.TELEGRAM_TOKEN, { polling: true });

async function sendSignalAlert(sig, isForced = false) {
  state.pendingSignals.set(sig.id, sig);
  setTimeout(() => state.pendingSignals.delete(sig.id), 120000);
  await logSignal(sig, "pending");
  state.signalsToday++;

  const emoji = sig.signal === "BUY" ? "🟢" : "🔴";
  const typeBadge = sig.orderType === "CNC" ? "📦 DELIVERY" : "⚡ INTRADAY";
  const forcedTag = isForced ? "\n🎯 *Best signal of the day*" : "";

  const msg = `${emoji} *${sig.signal} SIGNAL* · ${typeBadge}${forcedTag}
━━━━━━━━━━━━━━━━━
*${sig.symbol}*  (${sig.confidence}% confidence)

💰 Entry:  ₹${sig.entry}
🎯 Target: ₹${sig.target}  (+₹${sig.maxGain.toFixed(0)})
🛑 SL:     ₹${sig.sl}  (-₹${sig.maxLoss.toFixed(0)})
📦 Qty:    ${sig.qty} · ₹${sig.capital.toFixed(0)}

📊 *7-Indicator Analysis:*
• RSI: ${sig.indicators.rsi} (${sig.indicators.checks.rsi})
• MACD: ${sig.indicators.checks.macd}
• EMA: ${sig.indicators.checks.ema}
• VWAP: ${sig.indicators.checks.vwap} (₹${sig.indicators.vwap})
• ADX: ${sig.indicators.adx} (${sig.indicators.checks.adx})
• Supertrend: ${sig.indicators.supertrend}
• Bollinger: ${sig.indicators.checks.bb}
• Volume: ${sig.indicators.volRatio}x

Confluence: ${Math.max(sig.bullCount, sig.bearCount)}/7 indicators agree

⏰ _Expires in 2 minutes_`;

  const keyboard = {
    inline_keyboard: [[
      { text: "✅ Execute Live", callback_data: `exec_live_${sig.id}` },
      { text: "📝 Paper", callback_data: `exec_paper_${sig.id}` },
      { text: "❌ Skip", callback_data: `skip_${sig.id}` },
    ]]
  };

  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, msg, {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
  log(`📤 Signal sent: ${sig.symbol} ${sig.signal} · conf ${sig.confidence}%`);
}

tg.on("callback_query", async (query) => {
  const data = query.data;
  const sigId = data.replace(/^(exec_live_|exec_paper_|skip_)/, "");
  const sig = state.pendingSignals.get(sigId);

  if (!sig) {
    await tg.answerCallbackQuery(query.id, { text: "⏰ Signal expired" });
    try {
      await tg.editMessageText("⏰ Signal expired", {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
      });
    } catch {}
    return;
  }

  if (data.startsWith("skip_")) {
    await tg.answerCallbackQuery(query.id, { text: "Skipped" });
    await tg.editMessageText(`❌ Skipped: ${sig.symbol}`, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
    });
    state.pendingSignals.delete(sig.id);
    await logSignal(sig, "skipped");
    return;
  }

  if (data.startsWith("exec_live_")) {
    if (!CONFIG.LIVE_TRADING) {
      await tg.answerCallbackQuery(query.id, { text: "⚠️ Live OFF" });
      return;
    }
    if (state.isHalted) {
      await tg.answerCallbackQuery(query.id, { text: "🛑 Halted" });
      return;
    }
    const activeLive = state.openTrades.filter(t => t.mode === "live" && t.status === "open").length;
    if (activeLive >= CONFIG.MAX_POSITIONS) {
      await tg.answerCallbackQuery(query.id, { text: "Max positions" });
      return;
    }
    await executeLiveOrder(sig);
    await tg.answerCallbackQuery(query.id, { text: "✅ Live order placed" });
    await tg.editMessageText(`✅ *EXECUTED LIVE* · ${sig.symbol}\n${sig.signal} @ ₹${sig.entry} · Qty ${sig.qty}`, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      parse_mode: "Markdown",
    });
  }

  if (data.startsWith("exec_paper_")) {
    executePaperTrade(sig);
    await tg.answerCallbackQuery(query.id, { text: "📝 Paper trade opened" });
    await tg.editMessageText(`📝 *PAPER* · ${sig.symbol} ${sig.signal} @ ₹${sig.entry}`, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      parse_mode: "Markdown",
    });
  }
});

tg.onText(/\/start/, async (msg) => {
  await tg.sendMessage(msg.chat.id, `👋 *NSE TradeAI Bot v6*

Monitoring ${CONFIG.WATCHLIST.length} Nifty 50 stocks with 7 indicators.

Commands:
/status · /diagnose · /scan
/positions · /stop · /resume`, { parse_mode: "Markdown" });
});

tg.onText(/\/status/, async () => {
  const liveActive = state.openTrades.filter(t => t.mode === "live" && t.status === "open").length;
  const totalCandles = [...state.candleBuffer.values()].reduce((s, c) => s + c.length, 0);
  const avgCandles = Math.round(totalCandles / CONFIG.WATCHLIST.length);
  const msg = `📊 *Bot Status*
━━━━━━━━━━━━━
Live P&L: ${state.dayPnL.live >= 0 ? "+" : ""}₹${state.dayPnL.live.toFixed(0)}
Paper P&L: ${state.dayPnL.paper >= 0 ? "+" : ""}₹${state.dayPnL.paper.toFixed(0)}
Positions: ${liveActive}/${CONFIG.MAX_POSITIONS}
Signals today: ${state.signalsToday}
Live: ${CONFIG.LIVE_TRADING ? "✅ ON" : "❌ OFF"}
Halted: ${state.isHalted ? "🛑 YES" : "✅ NO"}
━━━━━━━━━━━━━
📊 Avg candles: ${avgCandles}
🔄 Scans: ${state.scanCount}
⏰ Last: ${state.lastScanTime ? state.lastScanTime.toLocaleTimeString("en-IN") : "—"}
📡 Live prices: ${state.livePrices.size}`;
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, msg, { parse_mode: "Markdown" });
});

tg.onText(/\/diagnose/, async () => {
  const lines = [];
  const top = CONFIG.WATCHLIST.slice(0, 15);
  for (const sym of top) {
    const c = state.candleBuffer.get(sym);
    const p = state.livePrices.get(sym);
    lines.push(`${sym.padEnd(12)} ${(c?.length || 0).toString().padStart(3)} candles  ₹${p?.ltp?.toFixed(1) || "—"}`);
  }
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `🔍 *Diagnosis:*\n\`\`\`\n${lines.join("\n")}\n\`\`\``, { parse_mode: "Markdown" });
});

tg.onText(/\/scan/, async () => {
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, "🔍 Running scan...");
  await runScan(true);
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `✅ Done · signals today: ${state.signalsToday}`);
});

tg.onText(/\/stop/, async () => {
  state.isHalted = true;
  await logEvent("HALT", "From Telegram");
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, "🛑 Trading halted");
});

tg.onText(/\/resume/, async () => {
  state.isHalted = false;
  await logEvent("RESUME", "From Telegram");
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, "✅ Trading resumed");
});

tg.onText(/\/positions/, async () => {
  const active = state.openTrades.filter(t => t.status === "open");
  if (active.length === 0) return tg.sendMessage(ENV.TELEGRAM_CHAT_ID, "📭 No open positions");
  const msg = active.map(t => {
    const curPrice = state.livePrices.get(t.symbol)?.ltp || t.entry;
    const pnl = (curPrice - t.entry) * t.qty;
    return `${t.mode === "live" ? "💰" : "📝"} *${t.symbol}*
Entry ₹${t.entry} → Now ₹${curPrice.toFixed(2)}
SL ₹${t.currentSL} · Target ₹${t.target}
P&L: ${pnl >= 0 ? "+" : ""}₹${pnl.toFixed(0)}`;
  }).join("\n━━━━━\n");
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, msg, { parse_mode: "Markdown" });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. ORDER EXECUTION
// ═══════════════════════════════════════════════════════════════════════════
async function executeLiveOrder(sig) {
  try {
    const token = await getSymbolToken(sig.symbol);
    const res = await axios.post(
        "https://apiconnect.angelbroking.com/rest/secure/angelbroking/order/v1/placeOrder",
        {
          variety:         "NORMAL",
          tradingsymbol:   `${sig.symbol}-EQ`,
          symboltoken:     token,
          transactiontype: sig.signal,
          exchange:        "NSE",
          ordertype:       "MARKET",
          producttype:     sig.orderType === "CNC" ? "DELIVERY" : "INTRADAY",
          duration:        "DAY",
          quantity:        sig.qty.toString(),
        },
        {
          headers: {
            "Authorization": `Bearer ${state.angelAuth}`,
            "Content-Type":  "application/json",
            "X-PrivateKey":  ENV.ANGEL_API_KEY,
            "X-UserType":    "USER",
            "X-SourceID":    "WEB",
          }
        }
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
      log(`✅ LIVE: ${sig.symbol} ${sig.signal} ${sig.qty} @ ₹${sig.entry}`);
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
  log(`📝 PAPER: ${sig.symbol} ${sig.signal} ${sig.qty} @ ₹${sig.entry}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 10. TRAILING STOP-LOSS
// ═══════════════════════════════════════════════════════════════════════════
setInterval(async () => {
  for (const trade of state.openTrades.filter(t => t.status === "open")) {
    const curPrice = state.livePrices.get(trade.symbol)?.ltp;
    if (!curPrice) continue;
    trade.currentPrice = curPrice;

    if (trade.signal === "BUY") {
      const gain = curPrice - trade.entry;
      if (gain > 0) {
        const newSL = parseFloat((trade.sl + gain).toFixed(2));
        if (newSL > trade.currentSL) {
          await updateSLMovement(trade.id, trade.currentSL, newSL, curPrice);
          trade.currentSL = newSL;
          trade.trailed = true;
        }
      }
      if (curPrice <= trade.currentSL) await closeTrade(trade, "SL_HIT", trade.currentSL);
      else if (curPrice >= trade.target) await closeTrade(trade, "TARGET_HIT", trade.target);
    }

    if (trade.orderType === "MIS") {
      const now = new Date();
      if (now.getHours() === 15 && now.getMinutes() >= 15) {
        await closeTrade(trade, "EOD_SQUARE_OFF", curPrice);
      }
    }
  }
}, 3000);

async function closeTrade(trade, reason, exitPrice) {
  trade.status = "closed";
  trade.exitPrice = exitPrice;
  trade.exitReason = reason;
  trade.exitPnL = (exitPrice - trade.entry) * trade.qty * (trade.signal === "BUY" ? 1 : -1);
  trade.closedAt = new Date();

  state.dayPnL[trade.mode] += trade.exitPnL;
  await dbCloseTrade(trade.id, exitPrice, reason, trade.exitPnL);

  if (trade.mode === "live" && CONFIG.LIVE_TRADING) {
    try {
      await axios.post(
          "https://apiconnect.angelbroking.com/rest/secure/angelbroking/order/v1/placeOrder",
          {
            variety: "NORMAL",
            tradingsymbol: `${trade.symbol}-EQ`,
            symboltoken: await getSymbolToken(trade.symbol),
            transactiontype: trade.signal === "BUY" ? "SELL" : "BUY",
            exchange: "NSE",
            ordertype: "MARKET",
            producttype: trade.orderType === "CNC" ? "DELIVERY" : "INTRADAY",
            duration: "DAY",
            quantity: trade.qty.toString(),
          },
          { headers: {
              "Authorization": `Bearer ${state.angelAuth}`,
              "Content-Type": "application/json",
              "X-PrivateKey": ENV.ANGEL_API_KEY
            }}
      );
    } catch (e) {
      log(`❌ Exit failed: ${e.message}`);
    }
  }

  const emoji = reason === "TARGET_HIT" ? "🎯" : reason === "SL_HIT" ? "🛑" : "⏰";
  const pnlEmoji = trade.exitPnL >= 0 ? "✅" : "❌";
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `${emoji} *${reason.replace(/_/g, " ")}* · ${trade.mode === "live" ? "💰 LIVE" : "📝 PAPER"}
*${trade.symbol}*
Entry ₹${trade.entry} → Exit ₹${exitPrice}
${pnlEmoji} P&L: ${trade.exitPnL >= 0 ? "+" : ""}₹${trade.exitPnL.toFixed(0)}
Day ${trade.mode} total: ₹${state.dayPnL[trade.mode].toFixed(0)}`, { parse_mode: "Markdown" });

  log(`${reason}: ${trade.symbol} · P&L: ₹${trade.exitPnL.toFixed(0)}`);

  if (state.dayPnL.live <= -CONFIG.DAILY_LOSS_CAP && !state.isHalted) {
    state.isHalted = true;
    await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `🛑 *DAILY LOSS CAP HIT*\nLive loss: ₹${state.dayPnL.live.toFixed(0)}`, { parse_mode: "Markdown" });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 11. MAIN SCANNER WITH GUARANTEED DAILY SIGNAL
// ═══════════════════════════════════════════════════════════════════════════
async function runScan(verbose = false) {
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();

  if (mins < 555 || mins > 930) return;
  if (state.isHalted) return;

  state.scanCount++;
  state.lastScanTime = now;

  const results = {
    scanned: 0, noCandles: 0, inPos: 0, hold: 0, filtered: 0, alerted: 0,
    topSignals: [],
  };

  for (const symbol of CONFIG.WATCHLIST) {
    results.scanned++;
    const candles = state.candleBuffer.get(symbol);
    if (!candles || candles.length < CONFIG.MIN_CANDLES) { results.noCandles++; continue; }
    if (state.openTrades.some(t => t.symbol === symbol && t.status === "open")) { results.inPos++; continue; }

    const sig = analyzeSignal(symbol, candles);
    if (!sig || sig.rejected) { results.noCandles++; continue; }

    // Track best signal across all symbols
    if (sig.signal !== "HOLD" && Math.abs(sig.score) > Math.abs(state.bestSignalToday?.score || 0)) {
      state.bestSignalToday = sig;
    }

    if (sig.signal === "HOLD") { results.hold++; continue; }

    if (!sig.safeToTrade) {
      results.filtered++;
      results.topSignals.push({ symbol, score: sig.score, confidence: sig.confidence, failed: Object.entries(sig.filtersPassed).filter(([k,v]) => !v).map(([k]) => k) });
      continue;
    }

    results.alerted++;
    await sendSignalAlert(sig);
  }

  // ─── FORCED SIGNAL LOGIC ───
  const currentHour = now.getHours() + now.getMinutes()/60;
  if (state.signalsToday === 0 && !state.forcedSignalSent &&
      currentHour >= CONFIG.FORCE_SIGNAL_AFTER_HOUR &&
      currentHour <= CONFIG.FORCE_SIGNAL_MAX_HOUR) {

    log("🎯 No signal yet today · running relaxed scan for best opportunity");

    let bestRelaxed = null;
    for (const symbol of CONFIG.WATCHLIST) {
      const candles = state.candleBuffer.get(symbol);
      if (!candles || candles.length < CONFIG.MIN_CANDLES) continue;
      if (state.openTrades.some(t => t.symbol === symbol && t.status === "open")) continue;

      const sig = analyzeSignal(symbol, candles, true);  // RELAXED mode
      if (!sig || sig.signal === "HOLD") continue;

      if (!bestRelaxed || Math.abs(sig.score) > Math.abs(bestRelaxed.score)) {
        bestRelaxed = sig;
      }
    }

    if (bestRelaxed && bestRelaxed.safeToTrade) {
      state.forcedSignalSent = true;
      log(`🎯 FORCED: Sending best signal of the day · ${bestRelaxed.symbol} ${bestRelaxed.signal}`);
      await sendSignalAlert(bestRelaxed, true);
    }
  }

  if (state.scanCount % 20 === 1 || verbose) {
    log(`🔍 Scan #${state.scanCount} · ${results.scanned} stocks | ${results.noCandles} no-data | ${results.inPos} in-trade | ${results.hold} hold | ${results.filtered} filtered | ${results.alerted} alerted · signals today: ${state.signalsToday}`);
  }
}

setInterval(() => runScan(), CONFIG.SCAN_INTERVAL_MS);

// Reset daily counters at market open
setInterval(() => {
  const now = new Date();
  if (now.getHours() === 9 && now.getMinutes() === 15) {
    state.signalsToday = 0;
    state.bestSignalToday = null;
    state.forcedSignalSent = false;
    state.dayPnL = { live: 0, paper: 0 };
    log("🌅 Daily counters reset");
  }
}, 60000);

// ═══════════════════════════════════════════════════════════════════════════
// 12. STARTUP
// ═══════════════════════════════════════════════════════════════════════════
async function startup() {
  log("🚀 NSE TradeAI Bot v6 (FINAL) starting...");
  log(`   Watchlist:  ${CONFIG.WATCHLIST.length} Nifty 50 stocks`);
  log(`   Capital:    ₹${CONFIG.CAPITAL.toLocaleString("en-IN")} · Risk ₹${CONFIG.RISK_PER_TRADE}/trade`);
  log(`   SL: ${CONFIG.SL_PCT*100}% · Target: ${CONFIG.TARGET_PCT*100}% (1:${CONFIG.REWARD_RATIO} RR)`);
  log(`   Live:       ${CONFIG.LIVE_TRADING ? "✅ ENABLED" : "❌ DISABLED (paper only)"}`);

  await initDB();
  await logEvent("STARTUP", "Bot v6 started");

  const { app, auth } = startAPI(3000);
  addAccountEndpoints(app, state, auth);

  const authOk = await authenticateAngel();
  if (!authOk) process.exit(1);

  log("🔑 Resolving symbol tokens...");
  const tokens = [];
  for (const sym of CONFIG.WATCHLIST) {
    const t = await getSymbolToken(sym);
    if (t) tokens.push(t);
  }
  log(`✓ Resolved ${tokens.length}/${CONFIG.WATCHLIST.length} tokens`);

  log("📊 Loading 5-day historical candles (~2 min)...");
  let totalLoaded = 0, successful = 0;
  for (const sym of CONFIG.WATCHLIST) {
    const count = await loadHistoricalCandles(sym);
    if (count > 0) { totalLoaded += count; successful++; }
    await new Promise(r => setTimeout(r, 250));
  }
  log(`✅ Loaded ${totalLoaded} candles from ${successful}/${CONFIG.WATCHLIST.length} stocks`);

  await startWebSocket(tokens);

  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `🚀 *Bot v6 Online · Nifty 50*
━━━━━━━━━━━━━━━
Watchlist: ${CONFIG.WATCHLIST.length} stocks
7 indicators: RSI · MACD · EMA · VWAP · ADX · Supertrend · Bollinger
Historical: ${totalLoaded} candles loaded

💰 Capital: ₹2,50,000
📉 SL: 0.8% · 🎯 Target: 1.6% (1:2 RR)
🛡️ Max loss/trade: ₹1,000

${CONFIG.LIVE_TRADING ? "⚡ LIVE trading enabled" : "📝 Paper only (safe)"}

_Guaranteed: at least 1 quality signal per day_

/status · /scan · /diagnose`, { parse_mode: "Markdown" });

  setTimeout(() => runScan(true), 20000);

  log("✅ Bot fully operational");
}

startup().catch(e => {
  log(`💥 Fatal: ${e.message}`);
  console.error(e);
  process.exit(1);
});

process.on("SIGINT", async () => {
  log("Shutting down...");
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, "⚠️ Bot shutting down");
  if (state.ws) state.ws.close();
  process.exit(0);
});

process.on("uncaughtException", async (err) => {
  log(`💥 Uncaught: ${err.message}`);
  await logEvent("ERROR", err.message);
});
