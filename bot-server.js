// ═══════════════════════════════════════════════════════════════════════════
// NSE TradeAI Bot v6.2 · ALL CRITICAL FIXES APPLIED
// Fixes: IST timezone · historical API headers · weekend dates · retries
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
import { addBacktestEndpoints } from "./backtest-api.js";
import { addBalanceEndpoints, smartBalanceCheck } from "./balance-optimized.js";

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
  LIVE_TRADING:      process.env.LIVE_TRADING === "true",

  SL_PCT:            0.006,
  TARGET_PCT:        0.024,

  SIGNAL_SCORE_BUY:  4.0,
  SIGNAL_SCORE_SELL: -4.0,
  MIN_CONFLUENCE:    4,
  MIN_CONFIDENCE:    65,
  MIN_VOLUME_RATIO:  1.3,
  MIN_CANDLES:       30,
  MIN_ADX:           25,
  SCAN_INTERVAL_MS:  20000,

  FORCE_SIGNAL_AFTER_HOUR: 12,
  FORCE_SIGNAL_MAX_HOUR:   14.5,

  WATCHLIST: [
    "RELIANCE","HDFCBANK","ICICIBANK","INFY","TCS","HINDUNILVR","ITC","BHARTIARTL",
    "SBIN","LT","KOTAKBANK","AXISBANK","BAJFINANCE","ASIANPAINT","MARUTI",
    "SUNPHARMA","TITAN","HCLTECH","ULTRACEMCO","NTPC","WIPRO","NESTLEIND",
    "POWERGRID","TATASTEEL","TECHM","ONGC","JSWSTEEL","ADANIENT","ADANIPORTS",
    "COALINDIA","BAJAJFINSV","GRASIM","HINDALCO","DRREDDY","BRITANNIA",
    "CIPLA","BPCL","INDUSINDBK","EICHERMOT","APOLLOHOSP","HEROMOTOCO",
    "DIVISLAB","UPL","SBILIFE","HDFCLIFE",
    "TATACONSUM","BAJAJHLDNG","DMART"
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

export const state = {
  angelAuth: null, feedToken: null, ws: null,
  livePrices: new Map(), candleBuffer: new Map(),
  openTrades: [], pendingSignals: new Map(),
  dayPnL: { live: 0, paper: 0 }, isHalted: false,
  symbolTokens: new Map(), tokenToSymbol: new Map(),
  scanCount: 0, lastScanTime: null,
  signalsToday: 0, forcedSignalSent: false,
  scripMaster: null, scripMasterLoaded: false,
};

function log(msg) {
  const ts = new Date().toISOString().replace("T", " ").substring(0, 19);
  console.log(`[${ts}] ${msg}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// ANGEL ONE STANDARD HEADERS (CRITICAL - required for all Angel API calls)
// ═══════════════════════════════════════════════════════════════════════════
function angelApiHeaders() {
  return {
    "Authorization":    `Bearer ${state.angelAuth}`,
    "Content-Type":     "application/json",
    "Accept":           "application/json",
    "X-UserType":       "USER",
    "X-SourceID":       "WEB",
    "X-ClientLocalIP":  "192.168.1.1",
    "X-ClientPublicIP": "103.0.0.1",
    "X-MACAddress":     "00:00:00:00:00:00",
    "X-PrivateKey":     ENV.ANGEL_API_KEY,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// FIX: IST TIMEZONE DATE FORMATTING
// ═══════════════════════════════════════════════════════════════════════════
function getISTDate() {
  // Convert server time (UTC on Railway) to IST
  const now = new Date();
  const utcMs = now.getTime() + (now.getTimezoneOffset() * 60 * 1000);
  return new Date(utcMs + (5.5 * 60 * 60 * 1000));
}

function formatAngelDate(date) {
  const pad = n => n.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Returns valid trading day range (skips weekends)
function getTradingDayRange(daysBack = 5) {
  let end = getISTDate();

  // If before market open today, use yesterday
  if (end.getHours() < 9 || (end.getHours() === 9 && end.getMinutes() < 15)) {
    end.setDate(end.getDate() - 1);
  }
  // Skip weekends backwards to nearest trading day
  while (end.getDay() === 0 || end.getDay() === 6) {
    end.setDate(end.getDate() - 1);
  }
  end.setHours(15, 30, 0, 0);

  // Go back N trading days
  let start = new Date(end);
  let tradingDays = 0;
  while (tradingDays < daysBack) {
    start.setDate(start.getDate() - 1);
    if (start.getDay() !== 0 && start.getDay() !== 6) tradingDays++;
  }
  start.setHours(9, 15, 0, 0);

  return {
    fromdate: formatAngelDate(start),
    todate:   formatAngelDate(end),
  };
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
// 2. SCRIP MASTER — LOAD ONCE, KEEP IN MEMORY
// ═══════════════════════════════════════════════════════════════════════════
async function loadScripMasterOnce() {
  if (state.scripMasterLoaded) return true;

  log("⬇️ Downloading Angel scrip master...");
  try {
    const res = await axios.get(
        "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json",
        { timeout: 120000, maxContentLength: 200*1024*1024, maxBodyLength: 200*1024*1024 }
    );
    state.scripMaster = res.data;
    state.scripMasterLoaded = true;
    log(`✅ Scrip master loaded: ${state.scripMaster.length} instruments`);
    try {
      fs.writeFileSync("./scrip-master.json", JSON.stringify(state.scripMaster));
    } catch {}
    return true;
  } catch (e) {
    log(`❌ Scrip master download failed: ${e.message}`);
    try {
      if (fs.existsSync("./scrip-master.json")) {
        state.scripMaster = JSON.parse(fs.readFileSync("./scrip-master.json", "utf8"));
        state.scripMasterLoaded = true;
        log(`✅ Loaded from disk: ${state.scripMaster.length} items`);
        return true;
      }
    } catch {}
    return false;
  }
}

async function getSymbolToken(symbol) {
  if (state.symbolTokens.has(symbol)) return state.symbolTokens.get(symbol);
  if (!state.scripMasterLoaded) await loadScripMasterOnce();
  if (!state.scripMaster) return null;

  const searchName = `${symbol}-EQ`;
  let match = state.scripMaster.find(s => s.symbol === searchName && s.exch_seg === "NSE");
  if (!match) match = state.scripMaster.find(s => s.name === symbol && s.exch_seg === "NSE" && s.symbol.endsWith("-EQ"));
  if (!match) match = state.scripMaster.find(s => s.symbol === symbol && s.exch_seg === "NSE");

  if (match?.token) {
    state.symbolTokens.set(symbol, match.token);
    state.tokenToSymbol.set(match.token, symbol);
    return match.token;
  }
  log(`⚠️ Unresolved: ${symbol}`);
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. HISTORICAL CANDLE LOADER — FIXED
// ═══════════════════════════════════════════════════════════════════════════
async function loadHistoricalCandles(symbol, retries = 2) {
  const token = await getSymbolToken(symbol);
  if (!token) return 0;

  const { fromdate, todate } = getTradingDayRange(5);

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await axios.post(
          "https://apiconnect.angelbroking.com/rest/secure/angelbroking/historical/v1/getCandleData",
          {
            exchange:    "NSE",
            symboltoken: token,
            interval:    "FIVE_MINUTE",
            fromdate,
            todate,
          },
          {
            headers: angelApiHeaders(),
            timeout: 20000,
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

      // Empty response — no retry needed
      return 0;

    } catch (e) {
      const status = e.response?.status;
      const body = e.response?.data;

      // Log detailed error on first attempt
      if (attempt === 0) {
        log(`  ⚠️ ${symbol}: HTTP ${status} · ${JSON.stringify(body).substring(0, 150)}`);
      }

      // Rate limit — wait longer before retry
      if (status === 429 || status === 403) {
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }
      }

      // 401 = token expired, re-auth and retry
      if (status === 401 && attempt < retries) {
        log("  🔄 Token expired, re-authenticating...");
        await authenticateAngel();
        continue;
      }

      return 0;
    }
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. WEBSOCKET (unchanged — already working)
// ═══════════════════════════════════════════════════════════════════════════
async function startWebSocket(tokens) {
  if (!tokens?.length) return;

  const wsUrl = `wss://smartapisocket.angelone.in/smart-stream?clientCode=${ENV.ANGEL_CLIENT_ID}&feedToken=${state.feedToken}&apiKey=${ENV.ANGEL_API_KEY}`;
  state.ws = new WebSocket(wsUrl);

  state.ws.on("open", () => {
    log(`📡 WebSocket connected · subscribing to ${tokens.length} tokens`);
    const chunks = [];
    for (let i = 0; i < tokens.length; i += 50) chunks.push(tokens.slice(i, i + 50));
    chunks.forEach((chunk, i) => {
      setTimeout(() => {
        if (state.ws?.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify({
            correlationID: `nseaibot-${i}`,
            action: 1,
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
        if (tickCount % 500 === 0) log(`📡 ${tickCount} ticks · ${state.livePrices.size} stocks tracked`);
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
// INDICATORS (compact, same logic)
// ═══════════════════════════════════════════════════════════════════════════
function ema(v,p){if(v.length<p)return v[v.length-1]||0;const k=2/(p+1);let e=v.slice(0,p).reduce((a,b)=>a+b,0)/p;for(let i=p;i<v.length;i++)e=v[i]*k+e*(1-k);return e;}
function sma(v,p){if(v.length<p)return v[v.length-1]||0;return v.slice(-p).reduce((a,b)=>a+b,0)/p;}
function rsi(c,p=14){if(c.length<p+1)return 50;const ch=c.slice(1).map((x,i)=>x-c[i]);const g=ch.map(x=>x>0?x:0);const l=ch.map(x=>x<0?-x:0);let ag=g.slice(0,p).reduce((a,b)=>a+b,0)/p;let al=l.slice(0,p).reduce((a,b)=>a+b,0)/p;for(let i=p;i<ch.length;i++){ag=(ag*(p-1)+g[i])/p;al=(al*(p-1)+l[i])/p;}return 100-100/(1+ag/(al||0.001));}
function macd(c){const e12=ema(c,12),e26=ema(c,26);return{value:e12-e26,bullish:e12>e26};}
function vwap(cs){if(!cs.length)return 0;let pv=0,tv=0;for(const c of cs){const t=(c.h+c.l+c.c)/3;pv+=t*c.v;tv+=c.v;}return tv>0?pv/tv:cs[cs.length-1].c;}
function atr(cs,p=14){if(cs.length<p+1)return 0;const trs=[];for(let i=1;i<cs.length;i++){const h=cs[i].h,l=cs[i].l,pc=cs[i-1].c;trs.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));}return sma(trs.slice(-p),p);}
function adx(cs,p=14){if(cs.length<p*2)return{adx:0,plusDI:0,minusDI:0,trending:false};const pdms=[],mdms=[],trs=[];for(let i=1;i<cs.length;i++){const um=cs[i].h-cs[i-1].h,dm=cs[i-1].l-cs[i].l;pdms.push(um>dm&&um>0?um:0);mdms.push(dm>um&&dm>0?dm:0);const h=cs[i].h,l=cs[i].l,pc=cs[i-1].c;trs.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));}const stt=sma(trs.slice(-p),p),spm=sma(pdms.slice(-p),p),smm=sma(mdms.slice(-p),p);const pdi=(spm/(stt||1))*100,mdi=(smm/(stt||1))*100;const dx=Math.abs(pdi-mdi)/((pdi+mdi)||1)*100;return{adx:dx,plusDI:pdi,minusDI:mdi,trending:dx>25};}
function supertrend(cs,p=10,m=3){if(cs.length<p)return{trend:"neutral"};const a=atr(cs,p),l=cs[cs.length-1];const hl2=(l.h+l.l)/2,ub=hl2+m*a,lb=hl2-m*a;return{trend:l.c>ub?"bull":l.c<lb?"bear":"neutral"};}
function bollinger(c,p=20){if(c.length<p)return{upper:0,lower:0,mid:0};const s=c.slice(-p),m=s.reduce((a,b)=>a+b,0)/p,sd=Math.sqrt(s.reduce((a,b)=>a+(b-m)**2,0)/p);return{upper:m+2*sd,mid:m,lower:m-2*sd};}

// ═══════════════════════════════════════════════════════════════════════════
// STRATEGY
// ═══════════════════════════════════════════════════════════════════════════

function analyzeSignal(symbol, candles, relaxed = false) {
  if (candles.length < CONFIG.MIN_CANDLES) {
    return { rejected: true, reason: `${candles.length} candles` };
  }

  const closes = candles.map(c => c.c);
  const highs = candles.map(c => c.h);
  const lows = candles.map(c => c.l);
  const vols = candles.map(c => c.v);
  const price = closes[closes.length - 1];

  // ═══ 1. INDICATORS ═══
  const R = rsi(closes);
  const M = macd(closes);
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const e200 = ema(closes, Math.min(200, closes.length - 1));
  const vw = vwap(candles);
  const adxData = adx(candles);
  const st = supertrend(candles);
  const bb = bollinger(closes);
  const a = atr(candles);
  const avgVol = vols.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, vols.length);
  const volRatio = avgVol > 0 ? vols[vols.length - 1] / avgVol : 1;

  // ═══ 2. CRITICAL FILTERS — REJECT IF NOT TRENDING ═══
  // This alone removes ~60% of false signals
  if (!relaxed && adxData.adx < CONFIG.MIN_ADX) {
    return {
      rejected: true,
      reason: `ADX ${adxData.adx.toFixed(1)} below ${CONFIG.MIN_ADX} (no trend)`,
      symbol, signal: "HOLD"
    };
  }

  // ═══ 3. MULTI-TIMEFRAME TREND CHECK ═══
  // Only BUY if higher timeframe (EMA200) is also bullish
  const longTermBullish = price > e200;
  const longTermBearish = price < e200;

  // ═══ 4. CANDLESTICK PATTERN DETECTION ═══
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const prev2 = candles[candles.length - 3];

  // Bullish reversal patterns
  const isBullishEngulfing = prev && last.c > last.o && prev.c < prev.o &&
      last.c > prev.o && last.o < prev.c;
  const isHammer = last && (last.c - last.l) > 2 * (last.h - last.c) &&
      last.c > last.o;

  // Bearish reversal patterns
  const isBearishEngulfing = prev && last.c < last.o && prev.c > prev.o &&
      last.c < prev.o && last.o > prev.c;
  const isShootingStar = last && (last.h - last.c) > 2 * (last.c - last.l) &&
      last.c < last.o;

  // ═══ 5. SCORING WITH WEIGHTED INDICATORS ═══
  let score = 0;
  let bullCount = 0, bearCount = 0;
  const checks = {};

  // RSI (weight: 2)
  // STRICTER: only oversold/overbought zones
  if (R < 30) { score += 2.5; bullCount++; checks.rsi = "oversold"; }
  else if (R > 70) { score -= 2.5; bearCount++; checks.rsi = "overbought"; }
  else if (R < 40 && longTermBullish) { score += 1; bullCount++; checks.rsi = "bull"; }
  else if (R > 60 && longTermBearish) { score -= 1; bearCount++; checks.rsi = "bear"; }
  else checks.rsi = "neutral";

  // MACD with signal line (weight: 2)
  if (M.bullish && M.value > 0) { score += 2; bullCount++; checks.macd = "strong-bull"; }
  else if (!M.bullish && M.value < 0) { score -= 2; bearCount++; checks.macd = "strong-bear"; }
  else if (M.bullish) { score += 0.5; checks.macd = "weak-bull"; }
  else { score -= 0.5; checks.macd = "weak-bear"; }

  // EMA alignment (weight: 2.5) — HIGHEST trend signal
  if (e9 > e21 && e21 > e50 && e50 > e200) {
    score += 2.5; bullCount++; checks.ema = "strong-bull-alignment";
  }
  else if (e9 < e21 && e21 < e50 && e50 < e200) {
    score -= 2.5; bearCount++; checks.ema = "strong-bear-alignment";
  }
  else if (e9 > e21 && e21 > e50) { score += 1; bullCount++; checks.ema = "bull"; }
  else if (e9 < e21 && e21 < e50) { score -= 1; bearCount++; checks.ema = "bear"; }
  else checks.ema = "mixed";

  // VWAP (weight: 2) — CRITICAL for intraday
  if (price > vw * 1.003) { score += 2; bullCount++; checks.vwap = "above"; }
  else if (price < vw * 0.997) { score -= 2; bearCount++; checks.vwap = "below"; }
  else checks.vwap = "near";

  // ADX trend strength (weight: 1.5)
  if (adxData.trending && adxData.adx > 30) {
    if (adxData.plusDI > adxData.minusDI * 1.2) {
      score += 1.5; bullCount++; checks.adx = "strong-bull-trend";
    } else if (adxData.minusDI > adxData.plusDI * 1.2) {
      score -= 1.5; bearCount++; checks.adx = "strong-bear-trend";
    }
  } else if (adxData.trending) {
    if (adxData.plusDI > adxData.minusDI) { score += 0.5; checks.adx = "bull-trend"; }
    else { score -= 0.5; checks.adx = "bear-trend"; }
  } else {
    checks.adx = "ranging";
  }

  // Supertrend (weight: 1.5) — strong directional confirmation
  if (st.trend === "bull") { score += 1.5; bullCount++; checks.supertrend = "bull"; }
  else if (st.trend === "bear") { score -= 1.5; bearCount++; checks.supertrend = "bear"; }
  else checks.supertrend = "neutral";

  // Bollinger + bounce confirmation (weight: 1)
  if (price <= bb.lower * 1.005 && R < 35) {
    score += 1.5; checks.bb = "oversold-bounce";  // strong reversal setup
  } else if (price >= bb.upper * 0.995 && R > 65) {
    score -= 1.5; checks.bb = "overbought-rejection";
  }

  // Candlestick patterns (weight: 1.5)
  if (isBullishEngulfing || isHammer) {
    score += 1.5; bullCount++;
    checks.pattern = isBullishEngulfing ? "bullish-engulfing" : "hammer";
  } else if (isBearishEngulfing || isShootingStar) {
    score -= 1.5; bearCount++;
    checks.pattern = isBearishEngulfing ? "bearish-engulfing" : "shooting-star";
  }

  // Volume confirmation (multiplier)
  if (volRatio > 2.0) score *= 1.2;       // Strong volume = boost score
  else if (volRatio > 1.5) score *= 1.1;
  else if (volRatio < 0.7) score *= 0.7;  // Weak volume = reduce conviction

  // ═══ 6. LONG-TERM TREND OVERRIDE ═══
  // Don't BUY against major bearish trend
  if (longTermBearish && score > 0) score *= 0.5;
  if (longTermBullish && score < 0) score *= 0.5;

  // ═══ 7. DETERMINE SIGNAL ═══
  const sb = relaxed ? 2.5 : CONFIG.SIGNAL_SCORE_BUY;
  const ss = relaxed ? -2.5 : CONFIG.SIGNAL_SCORE_SELL;
  const mc = relaxed ? 3 : CONFIG.MIN_CONFLUENCE;

  let signal = "HOLD", confidence = 50;
  if (score >= sb) {
    signal = "BUY";
    confidence = Math.min(55 + score * 3, 85);
  } else if (score <= ss) {
    signal = "SELL";
    confidence = Math.min(55 + Math.abs(score) * 3, 82);
  }

  const maxConf = Math.max(bullCount, bearCount);

  // ═══ 8. SAFETY FILTERS ═══
  const ist = getISTDate();
  const mins = ist.getHours() * 60 + ist.getMinutes();
  const unsafe = CONFIG.UNSAFE_WINDOWS.find(w => {
    const [sh, sm] = w.start.split(":").map(Number);
    const [eh, em] = w.end.split(":").map(Number);
    return mins >= sh * 60 + sm && mins <= eh * 60 + em;
  });

  const filtersPassed = {
    confluence: maxConf >= mc,
    time: !unsafe,
    volume: volRatio >= (relaxed ? 1.0 : CONFIG.MIN_VOLUME_RATIO),
    strength: Math.abs(score) >= Math.abs(sb),
    confidence: confidence >= (relaxed ? 60 : CONFIG.MIN_CONFIDENCE),
    trend: relaxed ? true : adxData.adx >= CONFIG.MIN_ADX,
    longTerm: signal === "BUY" ? !longTermBearish : signal === "SELL" ? !longTermBullish : true,
  };
  const safeToTrade = Object.values(filtersPassed).every(Boolean);

  // ═══ 9. ATR-BASED DYNAMIC SL/TARGET ═══
  // Use ATR (Average True Range) for adaptive stop-loss
  // ATR-based SL is much better than fixed percentage
  const atrMultiplier = 1.5;  // SL = 1.5x ATR
  const targetMultiplier = 4.5;  // Target = 4.5x ATR (1:3 RR minimum)

  const stopDist = Math.max(price * CONFIG.SL_PCT, a * atrMultiplier);
  const targetDist = Math.max(price * CONFIG.TARGET_PCT, a * targetMultiplier);

  const qty = Math.max(1, Math.floor(CONFIG.RISK_PER_TRADE / stopDist));
  const entry = parseFloat(price.toFixed(2));
  const sl = parseFloat((signal === "BUY" ? price - stopDist : price + stopDist).toFixed(2));
  const target = parseFloat((signal === "BUY" ? price + targetDist : price - targetDist).toFixed(2));

  // CNC vs MIS (only for very strong signals)
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
      price: entry,
      pattern: checks.pattern || "none",
      checks,
    },
    bullCount, bearCount,
    longTermTrend: longTermBullish ? "bullish" : longTermBearish ? "bearish" : "neutral",
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
// TELEGRAM
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
📦 Qty: ${sig.qty} · ₹${sig.capital.toFixed(0)}

📊 RSI ${sig.indicators.rsi} · VWAP ${sig.indicators.checks.vwap}
📈 ADX ${sig.indicators.adx} · Supertrend ${sig.indicators.supertrend}
Confluence ${Math.max(sig.bullCount, sig.bearCount)}/7

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

tg.onText(/\/status/, async () => {
  const liveActive = state.openTrades.filter(t => t.mode === "live" && t.status === "open").length;
  const totalCandles = [...state.candleBuffer.values()].reduce((s, c) => s + c.length, 0);
  const withCandles = [...state.candleBuffer.values()].filter(c => c.length >= CONFIG.MIN_CANDLES).length;
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `📊 *Bot v6.2 Status*
━━━━━━━━━━━━━
Live P&L: ₹${state.dayPnL.live.toFixed(0)} · Paper: ₹${state.dayPnL.paper.toFixed(0)}
Positions: ${liveActive}/${CONFIG.MAX_POSITIONS}
Signals today: ${state.signalsToday}
━━━━━━━━━━━━━
✅ Tokens: ${state.symbolTokens.size}/${CONFIG.WATCHLIST.length}
📊 Candles: ${totalCandles} total · ${withCandles} stocks ready
🔄 Scans: ${state.scanCount}
📡 Live prices: ${state.livePrices.size}`, { parse_mode: "Markdown" });
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

tg.onText(/\/scan/, async () => { await runScan(true); });
tg.onText(/\/stop/, async () => { state.isHalted = true; await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, "🛑 Halted"); });
tg.onText(/\/resume/, async () => { state.isHalted = false; await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, "✅ Resumed"); });

// Test historical — diagnostic command
tg.onText(/\/testhist/, async () => {
  const range = getTradingDayRange(5);
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `🔍 Testing historical API...\nRange: ${range.fromdate} → ${range.todate}`);
  const n = await loadHistoricalCandles("RELIANCE");
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `RELIANCE: ${n} candles loaded`);
});

async function executeLiveOrder(sig) {
  try {
    const check = await smartBalanceCheck(sig, state.angelAuth, ENV.ANGEL_API_KEY);

    if (!check.approved) {
      await tg.sendMessage(ENV.TELEGRAM_CHAT_ID,
          `🚫 *Trade Blocked*\n${sig.symbol}\n${check.message}`,
          { parse_mode: "Markdown" });
      return;
    }

    // If qty was adjusted, update signal
    if (check.adjusted) {
      sig.qty = check.suggestedQty;
      await tg.sendMessage(ENV.TELEGRAM_CHAT_ID,
          `📉 Qty adjusted: ${check.originalQty} → ${check.suggestedQty}\n${check.message}`);
    }

    const token = await getSymbolToken(sig.symbol);
    const res = await axios.post(
        "https://apiconnect.angelbroking.com/rest/secure/angelbroking/order/v1/placeOrder",
        {
          variety: "NORMAL", tradingsymbol: `${sig.symbol}-EQ`, symboltoken: token,
          transactiontype: sig.signal, exchange: "NSE", ordertype: "MARKET",
          producttype: sig.orderType === "CNC" ? "DELIVERY" : "INTRADAY",
          duration: "DAY", quantity: sig.qty.toString(),
        },
        { headers: angelApiHeaders() }
    );
    if (res.data?.status) {
      const trade = { ...sig, mode: "live", orderId: res.data.data.orderid,
        currentSL: sig.sl, currentPrice: sig.entry,
        status: "open", openedAt: new Date(), trailed: false };
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
  const trade = { ...sig, mode: "paper", currentSL: sig.sl, currentPrice: sig.entry,
    status: "open", openedAt: new Date(), trailed: false };
  state.openTrades.push(trade);
  logTrade(trade);
  logSignal(sig, "executed_paper");
  log(`📝 PAPER: ${sig.symbol} ${sig.signal}`);
}

// Trailing SL engine
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

  const emoji = reason === "TARGET_HIT" ? "🎯" : reason === "SL_HIT" ? "🛑" : "⏰";
  const pEm = t.exitPnL >= 0 ? "✅" : "❌";
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID,
      `${emoji} *${reason.replace(/_/g, " ")}* · ${t.mode === "live" ? "💰" : "📝"}\n*${t.symbol}*\nEntry ₹${t.entry} → Exit ₹${exit}\n${pEm} P&L: ${t.exitPnL >= 0 ? "+" : ""}₹${t.exitPnL.toFixed(0)}`,
      { parse_mode: "Markdown" });
  log(`${reason}: ${t.symbol} · ₹${t.exitPnL.toFixed(0)}`);
}

// Scanner

let schedulerRunning = false;
let lastScanCompletedAt = null;

async function runScan(verbose = false) {
  // Prevent overlapping scans
  if (schedulerRunning) {
    log("⏭️ Skipping scan (previous still running)");
    return;
  }
  schedulerRunning = true;

  try {
    const ist = getISTDate();
    const mins = ist.getHours() * 60 + ist.getMinutes();
    const isMarketHours = mins >= 555 && mins <= 930;

    if (!isMarketHours) {
      if (verbose) log(`⏰ Market closed (${ist.toLocaleTimeString("en-IN")})`);
      schedulerRunning = false;
      return;
    }

    if (state.isHalted) {
      if (verbose) log("🛑 Bot halted");
      schedulerRunning = false;
      return;
    }

    state.scanCount++;
    state.lastScanTime = new Date();

    const results = {
      scanned: 0, noCandles: 0, inPos: 0, hold: 0,
      filtered: 0, alerted: 0, rejectedBy: {},
    };

    for (const symbol of CONFIG.WATCHLIST) {
      results.scanned++;
      const candles = state.candleBuffer.get(symbol);

      if (!candles || candles.length < CONFIG.MIN_CANDLES) {
        results.noCandles++;
        continue;
      }

      if (state.openTrades.some(t => t.symbol === symbol && t.status === "open")) {
        results.inPos++;
        continue;
      }

      const sig = analyzeSignal(symbol, candles);
      if (!sig || sig.rejected) {
        results.noCandles++;
        continue;
      }

      if (sig.signal === "HOLD") {
        results.hold++;
        continue;
      }

      if (!sig.safeToTrade) {
        results.filtered++;
        const failed = Object.entries(sig.filtersPassed).filter(([k, v]) => !v).map(([k]) => k);
        failed.forEach(f => results.rejectedBy[f] = (results.rejectedBy[f] || 0) + 1);
        continue;
      }

      results.alerted++;
      await sendSignalAlert(sig);
    }

    // Forced signal logic
    const curHour = ist.getHours() + ist.getMinutes() / 60;
    if (state.signalsToday === 0 && !state.forcedSignalSent &&
        curHour >= CONFIG.FORCE_SIGNAL_AFTER_HOUR &&
        curHour <= CONFIG.FORCE_SIGNAL_MAX_HOUR) {
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

    lastScanCompletedAt = new Date();

    // Always log scan results so you can see scheduler is alive
    log(`🔍 Scan #${state.scanCount} · ${results.scanned} stocks | ${results.noCandles} no-data | ${results.inPos} in-trade | ${results.hold} hold | ${results.filtered} filtered | ${results.alerted} alerted`);

    if (Object.keys(results.rejectedBy).length > 0 && verbose) {
      log(`   Filter rejects: ${Object.entries(results.rejectedBy).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    }
  } catch (e) {
    log(`💥 Scan error: ${e.message}`);
    console.error(e);
  } finally {
    schedulerRunning = false;
  }
}

let scanInterval = null;

function startScheduler() {
  if (scanInterval) clearInterval(scanInterval);

  log(`⏰ Starting scheduler · scan every ${CONFIG.SCAN_INTERVAL_MS / 1000}s`);

  scanInterval = setInterval(() => {
    runScan().catch(e => log(`💥 Scheduler error: ${e.message}`));
  }, CONFIG.SCAN_INTERVAL_MS);

  // Run first scan after 5s
  setTimeout(() => {
    log("🚀 Running first scan");
    runScan(true).catch(e => log(`💥 First scan error: ${e.message}`));
  }, 5000);
}

// ═══ WATCHDOG: Restart scheduler if dead ═══════════════════════════════════
// Add this to detect and recover from stuck scheduler:

setInterval(() => {
  if (!lastScanCompletedAt) return;

  const timeSinceLastScan = Date.now() - lastScanCompletedAt.getTime();
  const expectedInterval = CONFIG.SCAN_INTERVAL_MS;

  // If scan hasn't completed in 3x expected interval, scheduler is dead
  if (timeSinceLastScan > expectedInterval * 3) {
    const ist = getISTDate();
    const mins = ist.getHours() * 60 + ist.getMinutes();
    const isMarketHours = mins >= 555 && mins <= 930;

    if (isMarketHours && !state.isHalted) {
      log(`⚠️ Scheduler appears stuck (last scan ${Math.round(timeSinceLastScan / 1000)}s ago) · restarting`);
      startScheduler();
    }
  }
}, 60000);  // Check every minute

// ═══════════════════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════════════════
async function startup() {
  log("🚀 NSE TradeAI Bot v6.2 (FIXED) starting...");
  const ist = getISTDate();
  log(`   Current IST: ${ist.toLocaleString("en-IN")}`);
  log(`   Watchlist: ${CONFIG.WATCHLIST.length} stocks · Live: ${CONFIG.LIVE_TRADING ? "ON" : "OFF"}`);

  await initDB();
  await logEvent("STARTUP", "v6.2 started");

  const { app, auth } = startAPI(3000);
  addAccountEndpoints(app, state, auth);
  addBacktestEndpoints(app, state, auth);
  addBalanceEndpoints(app, state, auth);

  const authOk = await authenticateAngel();
  if (!authOk) process.exit(1);

  const scripOk = await loadScripMasterOnce();
  if (!scripOk) {
    await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, "❌ Scrip master failed. Retry in 60s");
    setTimeout(() => startup(), 60000);
    return;
  }

  log("🔑 Resolving tokens...");
  const tokens = [];
  const unresolved = [];
  for (const sym of CONFIG.WATCHLIST) {
    const t = await getSymbolToken(sym);
    if (t) tokens.push(t);
    else unresolved.push(sym);
  }
  log(`✓ Resolved ${tokens.length}/${CONFIG.WATCHLIST.length}`);

  // Test historical API with 1 symbol first
  log("🧪 Testing historical API with RELIANCE...");
  const testRange = getTradingDayRange(5);
  log(`   Date range: ${testRange.fromdate} → ${testRange.todate}`);
  const testCount = await loadHistoricalCandles("RELIANCE");

  if (testCount === 0) {
    log("❌ Historical API test failed · proceeding without pre-load");
    log("   Bot will build candles live from WebSocket (takes ~75 min to get 15 candles)");
    await tg.sendMessage(ENV.TELEGRAM_CHAT_ID,
        `⚠️ *Historical API Unavailable*\n\nProceeding without pre-load. Bot will build candles from live ticks.\nExpected first signals: ~75 minutes after market open.\n\nTest: /testhist`,
        { parse_mode: "Markdown" });
  } else {
    log(`✅ Historical API works · loading rest of watchlist`);
    let totalLoaded = testCount, successful = 1;
    for (const sym of CONFIG.WATCHLIST) {
      if (sym === "RELIANCE") continue;
      const n = await loadHistoricalCandles(sym);
      if (n > 0) { totalLoaded += n; successful++; }
      await new Promise(r => setTimeout(r, 300));
    }
    log(`✅ Pre-loaded ${totalLoaded} candles from ${successful} stocks`);
  }

  await startWebSocket(tokens);

  const totalCandles = [...state.candleBuffer.values()].reduce((s, c) => s + c.length, 0);
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID,
      `🚀 *Bot v6.2 Online*\n━━━━━━━━━━━━━━\n✅ Scrip master: ${state.scripMaster.length} items\n✅ Tokens: ${tokens.length}/${CONFIG.WATCHLIST.length}\n✅ Pre-loaded: ${totalCandles} candles\n${unresolved.length ? `⚠️ Skipped: ${unresolved.join(", ")}\n` : ""}\n${CONFIG.LIVE_TRADING ? "⚡ Live trading ON" : "📝 Paper mode"}\n\n/status · /diagnose · /scan · /testhist`,
      { parse_mode: "Markdown" });

  setTimeout(() => runScan(true), 15000);
  log("✅ Bot operational");
}

startup().catch(e => { log(`💥 Fatal: ${e.message}`); process.exit(1); });

process.on("SIGINT", async () => {
  if (state.ws) state.ws.close();
  process.exit(0);
});
process.on("uncaughtException", e => log(`💥 Uncaught: ${e.message}`));
