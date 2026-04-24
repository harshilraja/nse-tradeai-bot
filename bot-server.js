// ═══════════════════════════════════════════════════════════════════════════
// NSE TradeAI Bot v6.1 · CRITICAL FIX
// Fixes: Symbol resolution failure, scrip master caching, historical load
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
  VIX_DANGER:        22,
  LIVE_TRADING:      process.env.LIVE_TRADING === "true",

  SL_PCT:            0.008,
  TARGET_PCT:        0.016,

  SIGNAL_SCORE_BUY:  2.0,
  SIGNAL_SCORE_SELL: -2.0,
  MIN_CONFLUENCE:    2,
  MIN_CONFIDENCE:    55,
  MIN_VOLUME_RATIO:  0.8,
  MIN_CANDLES:       15,
  SCAN_INTERVAL_MS:  15000,

  FORCE_SIGNAL_AFTER_HOUR:   12,
  FORCE_SIGNAL_MAX_HOUR:     14.5,

  // ─── FIX: Verified Nifty 50 watchlist (removed problematic symbols) ───
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

  // ─── Symbols with non-standard naming in Angel's scrip master ───
  SYMBOL_OVERRIDES: {
    "M&M":          "M&M-EQ",
    "BAJAJ-AUTO":   "BAJAJ-AUTO-EQ",
    "SHRIRAMFIN":   "SHRIRAMFIN-EQ",
  },

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
  forcedSignalSent:  false,
  scripMaster:       null,  // ← FIX: Hold in memory, not disk
  scripMasterLoaded: false,
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
// ═══ CRITICAL FIX: LOAD SCRIP MASTER ONCE, KEEP IN MEMORY ═══
// ═══════════════════════════════════════════════════════════════════════════
async function loadScripMasterOnce() {
  if (state.scripMasterLoaded) return true;

  log("⬇️ Downloading Angel scrip master (one-time, ~30s)...");
  try {
    const res = await axios.get(
        "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json",
        {
          timeout: 120000,
          maxContentLength: 200 * 1024 * 1024,
          maxBodyLength: 200 * 1024 * 1024,
        }
    );
    state.scripMaster = res.data;
    state.scripMasterLoaded = true;
    log(`✅ Scrip master loaded: ${state.scripMaster.length} instruments in memory`);

    // Optional: cache to disk for next restart (might fail on Railway, that's OK)
    try {
      fs.writeFileSync("./scrip-master.json", JSON.stringify(state.scripMaster));
      log("💾 Scrip master also cached to disk");
    } catch (e) {
      log("ℹ️ Disk cache skipped (ephemeral filesystem)");
    }

    return true;
  } catch (e) {
    log(`❌ Failed to download scrip master: ${e.message}`);
    // Try to load from disk as fallback
    try {
      if (fs.existsSync("./scrip-master.json")) {
        state.scripMaster = JSON.parse(fs.readFileSync("./scrip-master.json", "utf8"));
        state.scripMasterLoaded = true;
        log(`✅ Loaded from disk cache: ${state.scripMaster.length} instruments`);
        return true;
      }
    } catch {}
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FIX: SYMBOL TOKEN RESOLVER WITH FUZZY MATCHING
// ═══════════════════════════════════════════════════════════════════════════
async function getSymbolToken(symbol) {
  if (state.symbolTokens.has(symbol)) return state.symbolTokens.get(symbol);
  if (!state.scripMasterLoaded) await loadScripMasterOnce();
  if (!state.scripMaster) return null;

  // Try multiple matching strategies
  const searchName = CONFIG.SYMBOL_OVERRIDES[symbol] || `${symbol}-EQ`;

  // Strategy 1: Exact match with -EQ suffix
  let match = state.scripMaster.find(s =>
      s.symbol === searchName && s.exch_seg === "NSE"
  );

  // Strategy 2: Match by base name
  if (!match) {
    match = state.scripMaster.find(s =>
        s.name === symbol && s.exch_seg === "NSE" && s.symbol.endsWith("-EQ")
    );
  }

  // Strategy 3: Match symbol without -EQ
  if (!match) {
    match = state.scripMaster.find(s =>
        s.symbol === symbol && s.exch_seg === "NSE"
    );
  }

  // Strategy 4: Partial name match (last resort)
  if (!match) {
    match = state.scripMaster.find(s =>
        s.exch_seg === "NSE" &&
        s.symbol.startsWith(symbol) &&
        s.symbol.endsWith("-EQ")
    );
  }

  if (match?.token) {
    state.symbolTokens.set(symbol, match.token);
    state.tokenToSymbol.set(match.token, symbol);
    return match.token;
  }

  log(`⚠️ Unresolved: ${symbol} (tried: ${searchName})`);
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// HISTORICAL CANDLE PRE-LOAD
// ═══════════════════════════════════════════════════════════════════════════
async function loadHistoricalCandles(symbol) {
  try {
    const token = await getSymbolToken(symbol);
    if (!token) {
      log(`❌ Skip ${symbol}: token not found`);
      return 0;
    }

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
    log(`  ⚠️ ${symbol}: hist load failed - ${e.message}`);
    return 0;
  }
}

function formatAngelDate(d) {
  const pad = n => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// WEBSOCKET
// ═══════════════════════════════════════════════════════════════════════════
async function startWebSocket(tokens) {
  if (!tokens || tokens.length === 0) {
    log("⚠️ No tokens to subscribe · WebSocket skipped");
    return;
  }

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
// CANDLE AGGREGATOR
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
// INDICATORS (same as v6)
// ═══════════════════════════════════════════════════════════════════════════
function ema(v, p) { if(v.length<p)return v[v.length-1]||0; const k=2/(p+1); let e=v.slice(0,p).reduce((a,b)=>a+b,0)/p; for(let i=p;i<v.length;i++)e=v[i]*k+e*(1-k); return e; }
function sma(v, p) { if(v.length<p)return v[v.length-1]||0; return v.slice(-p).reduce((a,b)=>a+b,0)/p; }
function rsi(c, p=14) { if(c.length<p+1)return 50; const ch=c.slice(1).map((x,i)=>x-c[i]); const g=ch.map(x=>x>0?x:0); const l=ch.map(x=>x<0?-x:0); let ag=g.slice(0,p).reduce((a,b)=>a+b,0)/p; let al=l.slice(0,p).reduce((a,b)=>a+b,0)/p; for(let i=p;i<ch.length;i++){ag=(ag*(p-1)+g[i])/p; al=(al*(p-1)+l[i])/p;} return 100-100/(1+ag/(al||0.001)); }
function macd(c) { const e12=ema(c,12), e26=ema(c,26), line=e12-e26; return {value:line, bullish:line>0}; }
function vwap(cs) { if(cs.length===0)return 0; let pv=0,tv=0; for(const c of cs){const t=(c.h+c.l+c.c)/3; pv+=t*c.v; tv+=c.v;} return tv>0?pv/tv:cs[cs.length-1].c; }
function atr(cs,p=14) { if(cs.length<p+1)return 0; const trs=[]; for(let i=1;i<cs.length;i++){const h=cs[i].h,l=cs[i].l,pc=cs[i-1].c; trs.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));} return sma(trs.slice(-p),p); }
function adx(cs,p=14) { if(cs.length<p*2)return {adx:0,plusDI:0,minusDI:0,trending:false}; const pdms=[],mdms=[],trs=[]; for(let i=1;i<cs.length;i++){const um=cs[i].h-cs[i-1].h, dm=cs[i-1].l-cs[i].l; pdms.push(um>dm&&um>0?um:0); mdms.push(dm>um&&dm>0?dm:0); const h=cs[i].h,l=cs[i].l,pc=cs[i-1].c; trs.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));} const stt=sma(trs.slice(-p),p), spm=sma(pdms.slice(-p),p), smm=sma(mdms.slice(-p),p); const pdi=(spm/(stt||1))*100, mdi=(smm/(stt||1))*100; const dx=Math.abs(pdi-mdi)/((pdi+mdi)||1)*100; return {adx:dx, plusDI:pdi, minusDI:mdi, trending:dx>25}; }
function supertrend(cs,p=10,m=3) { if(cs.length<p)return {trend:"neutral"}; const a=atr(cs,p), l=cs[cs.length-1]; const hl2=(l.h+l.l)/2, ub=hl2+m*a, lb=hl2-m*a; return {trend:l.c>ub?"bull":l.c<lb?"bear":"neutral"}; }
function bollinger(c,p=20) { if(c.length<p)return {upper:0,lower:0,mid:0}; const s=c.slice(-p), m=s.reduce((a,b)=>a+b,0)/p, sd=Math.sqrt(s.reduce((a,b)=>a+(b-m)**2,0)/p); return {upper:m+2*sd, mid:m, lower:m-2*sd}; }

// ═══════════════════════════════════════════════════════════════════════════
// STRATEGY ENGINE
// ═══════════════════════════════════════════════════════════════════════════
function analyzeSignal(symbol, candles, relaxed = false) {
  if (candles.length < CONFIG.MIN_CANDLES) return { rejected: true, reason: `${candles.length} candles` };

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

  let score = 0, bullCount = 0, bearCount = 0;
  const checks = {};

  if (R < 40) { score += 2; bullCount++; checks.rsi = "bull"; }
  else if (R > 60) { score -= 2; bearCount++; checks.rsi = "bear"; }
  else if (R >= 45 && R <= 55) { score += 0.3; checks.rsi = "neutral"; }
  else checks.rsi = "neutral";

  if (M.bullish) { score += 1.5; bullCount++; checks.macd = "bull"; }
  else { score -= 1.5; bearCount++; checks.macd = "bear"; }

  if (e9 > e21 && e21 > e50) { score += 2; bullCount++; checks.ema = "bull"; }
  else if (e9 < e21 && e21 < e50) { score -= 2; bearCount++; checks.ema = "bear"; }
  else if (e9 > e21) { score += 0.5; checks.ema = "bull-weak"; }
  else { score -= 0.5; checks.ema = "bear-weak"; }

  if (price > vw * 1.002) { score += 1.5; bullCount++; checks.vwap = "bull"; }
  else if (price < vw * 0.998) { score -= 1.5; bearCount++; checks.vwap = "bear"; }
  else checks.vwap = "neutral";

  if (adxData.trending) {
    if (adxData.plusDI > adxData.minusDI) { score += 1; checks.adx = "bull-trend"; }
    else { score -= 1; checks.adx = "bear-trend"; }
  } else checks.adx = "ranging";

  if (st.trend === "bull") { score += 1; bullCount++; checks.supertrend = "bull"; }
  else if (st.trend === "bear") { score -= 1; bearCount++; checks.supertrend = "bear"; }
  else checks.supertrend = "neutral";

  if (price <= bb.lower * 1.005) { score += 1; checks.bb = "oversold"; }
  else if (price >= bb.upper * 0.995) { score -= 1; checks.bb = "overbought"; }
  else checks.bb = "mid";

  if (volRatio > 1.5) score += Math.sign(score) * 1;
  else if (volRatio < 0.5) score *= 0.8;

  const scoreBuy = relaxed ? 1.5 : CONFIG.SIGNAL_SCORE_BUY;
  const scoreSell = relaxed ? -1.5 : CONFIG.SIGNAL_SCORE_SELL;
  const minConf = relaxed ? 1 : CONFIG.MIN_CONFLUENCE;

  let signal = "HOLD";
  let confidence = 50;
  if (score >= scoreBuy) { signal = "BUY"; confidence = Math.min(52 + score * 4, 80); }
  else if (score <= scoreSell) { signal = "SELL"; confidence = Math.min(52 + Math.abs(score) * 4, 78); }

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
// TELEGRAM BOT
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
📦 Volume ${sig.indicators.volRatio}x · Confluence ${Math.max(sig.bullCount, sig.bearCount)}/7

⏰ _Expires in 2 minutes_`;

  const keyboard = {
    inline_keyboard: [[
      { text: "✅ Execute", callback_data: `exec_live_${sig.id}` },
      { text: "📝 Paper", callback_data: `exec_paper_${sig.id}` },
      { text: "❌ Skip", callback_data: `skip_${sig.id}` },
    ]]
  };

  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, msg, {
    parse_mode: "Markdown", reply_markup: keyboard,
  });
  log(`📤 Signal sent: ${sig.symbol} ${sig.signal} · conf ${sig.confidence}%`);
}

tg.on("callback_query", async (query) => {
  const data = query.data;
  const sigId = data.replace(/^(exec_live_|exec_paper_|skip_)/, "");
  const sig = state.pendingSignals.get(sigId);

  if (!sig) {
    await tg.answerCallbackQuery(query.id, { text: "⏰ Expired" });
    try {
      await tg.editMessageText("⏰ Signal expired", {
        chat_id: query.message.chat.id, message_id: query.message.message_id,
      });
    } catch {}
    return;
  }

  if (data.startsWith("skip_")) {
    await tg.answerCallbackQuery(query.id, { text: "Skipped" });
    await tg.editMessageText(`❌ Skipped: ${sig.symbol}`, {
      chat_id: query.message.chat.id, message_id: query.message.message_id,
    });
    state.pendingSignals.delete(sig.id);
    await logSignal(sig, "skipped");
    return;
  }

  if (data.startsWith("exec_live_")) {
    if (!CONFIG.LIVE_TRADING) { await tg.answerCallbackQuery(query.id, { text: "⚠️ Live OFF" }); return; }
    if (state.isHalted) { await tg.answerCallbackQuery(query.id, { text: "🛑 Halted" }); return; }
    const activeLive = state.openTrades.filter(t => t.mode === "live" && t.status === "open").length;
    if (activeLive >= CONFIG.MAX_POSITIONS) { await tg.answerCallbackQuery(query.id, { text: "Max positions" }); return; }
    await executeLiveOrder(sig);
    await tg.answerCallbackQuery(query.id, { text: "✅ Live placed" });
    await tg.editMessageText(`✅ *LIVE* · ${sig.symbol} ${sig.signal} @ ₹${sig.entry} · Qty ${sig.qty}`, {
      chat_id: query.message.chat.id, message_id: query.message.message_id,
      parse_mode: "Markdown",
    });
  }

  if (data.startsWith("exec_paper_")) {
    executePaperTrade(sig);
    await tg.answerCallbackQuery(query.id, { text: "📝 Paper opened" });
    await tg.editMessageText(`📝 *PAPER* · ${sig.symbol} ${sig.signal} @ ₹${sig.entry}`, {
      chat_id: query.message.chat.id, message_id: query.message.message_id,
      parse_mode: "Markdown",
    });
  }
});

tg.onText(/\/start/, async (msg) => {
  await tg.sendMessage(msg.chat.id, `👋 *NSE TradeAI v6.1*\n\nMonitoring ${CONFIG.WATCHLIST.length} Nifty 50 stocks.\n\n/status · /diagnose · /scan\n/positions · /stop · /resume`, { parse_mode: "Markdown" });
});

tg.onText(/\/status/, async () => {
  const liveActive = state.openTrades.filter(t => t.mode === "live" && t.status === "open").length;
  const totalCandles = [...state.candleBuffer.values()].reduce((s, c) => s + c.length, 0);
  const resolvedCount = state.symbolTokens.size;
  const msg = `📊 *Bot Status v6.1*
━━━━━━━━━━━━━
Live P&L: ₹${state.dayPnL.live.toFixed(0)} · Paper: ₹${state.dayPnL.paper.toFixed(0)}
Positions: ${liveActive}/${CONFIG.MAX_POSITIONS}
Signals today: ${state.signalsToday}
Halted: ${state.isHalted ? "🛑 YES" : "✅ NO"}
━━━━━━━━━━━━━
✅ Symbols resolved: ${resolvedCount}/${CONFIG.WATCHLIST.length}
📊 Total candles: ${totalCandles}
🔄 Scans done: ${state.scanCount}
📡 Live prices: ${state.livePrices.size} stocks
⏰ Last scan: ${state.lastScanTime?.toLocaleTimeString("en-IN") || "—"}
🗄️ Scrip master: ${state.scripMasterLoaded ? `loaded (${state.scripMaster?.length || 0} items)` : "NOT LOADED"}`;
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, msg, { parse_mode: "Markdown" });
});

tg.onText(/\/diagnose/, async () => {
  const lines = [];
  for (const sym of CONFIG.WATCHLIST.slice(0, 15)) {
    const c = state.candleBuffer.get(sym);
    const p = state.livePrices.get(sym);
    const tok = state.symbolTokens.get(sym);
    lines.push(`${sym.padEnd(12)} ${tok ? "✓" : "✗"} ${(c?.length || 0).toString().padStart(3)}c ₹${p?.ltp?.toFixed(1) || "—"}`);
  }
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `🔍 *Diagnosis (first 15):*\n\`\`\`\n${lines.join("\n")}\n\`\`\`\n✓=token resolved · c=candles`, { parse_mode: "Markdown" });
});

tg.onText(/\/scan/, async () => {
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, "🔍 Scanning...");
  await runScan(true);
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `✅ Done · signals today: ${state.signalsToday}`);
});

tg.onText(/\/stop/, async () => {
  state.isHalted = true;
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, "🛑 Halted");
});

tg.onText(/\/resume/, async () => {
  state.isHalted = false;
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, "✅ Resumed");
});

tg.onText(/\/positions/, async () => {
  const active = state.openTrades.filter(t => t.status === "open");
  if (active.length === 0) return tg.sendMessage(ENV.TELEGRAM_CHAT_ID, "📭 No positions");
  const msg = active.map(t => {
    const cur = state.livePrices.get(t.symbol)?.ltp || t.entry;
    const pnl = (cur - t.entry) * t.qty * (t.signal === "BUY" ? 1 : -1);
    return `${t.mode === "live" ? "💰" : "📝"} *${t.symbol}*\nEntry ₹${t.entry} → Now ₹${cur.toFixed(2)}\nSL ₹${t.currentSL} · Target ₹${t.target}\nP&L: ${pnl >= 0 ? "+" : ""}₹${pnl.toFixed(0)}`;
  }).join("\n━━━━\n");
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, msg, { parse_mode: "Markdown" });
});

// ═══════════════════════════════════════════════════════════════════════════
// ORDER EXECUTION
// ═══════════════════════════════════════════════════════════════════════════
async function executeLiveOrder(sig) {
  try {
    const token = await getSymbolToken(sig.symbol);
    if (!token) {
      log(`❌ Skip ${symbol}: token not found`);
      return 0;
    }
    const res = await axios.post(
        "https://apiconnect.angelbroking.com/rest/secure/angelbroking/order/v1/placeOrder",
        {
          variety: "NORMAL", tradingsymbol: `${sig.symbol}-EQ`, symboltoken: token,
          transactiontype: sig.signal, exchange: "NSE", ordertype: "MARKET",
          producttype: sig.orderType === "CNC" ? "DELIVERY" : "INTRADAY",
          duration: "DAY", quantity: sig.qty.toString(),
        },
        { headers: {
            "Authorization": `Bearer ${state.angelAuth}`,
            "Content-Type": "application/json",
            "X-PrivateKey": ENV.ANGEL_API_KEY,
            "X-UserType": "USER", "X-SourceID": "WEB",
          }}
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
// TRAILING STOP-LOSS
// ═══════════════════════════════════════════════════════════════════════════
setInterval(async () => {
  for (const trade of state.openTrades.filter(t => t.status === "open")) {
    const cur = state.livePrices.get(trade.symbol)?.ltp;
    if (!cur) continue;
    trade.currentPrice = cur;

    if (trade.signal === "BUY") {
      const gain = cur - trade.entry;
      if (gain > 0) {
        const newSL = parseFloat((trade.sl + gain).toFixed(2));
        if (newSL > trade.currentSL) {
          await updateSLMovement(trade.id, trade.currentSL, newSL, cur);
          trade.currentSL = newSL;
          trade.trailed = true;
        }
      }
      if (cur <= trade.currentSL) await closeTrade(trade, "SL_HIT", trade.currentSL);
      else if (cur >= trade.target) await closeTrade(trade, "TARGET_HIT", trade.target);
    }

    if (trade.orderType === "MIS") {
      const now = new Date();
      if (now.getHours() === 15 && now.getMinutes() >= 15) {
        await closeTrade(trade, "EOD_SQUARE_OFF", cur);
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
            variety: "NORMAL", tradingsymbol: `${trade.symbol}-EQ`,
            symboltoken: await getSymbolToken(trade.symbol),
            transactiontype: trade.signal === "BUY" ? "SELL" : "BUY",
            exchange: "NSE", ordertype: "MARKET",
            producttype: trade.orderType === "CNC" ? "DELIVERY" : "INTRADAY",
            duration: "DAY", quantity: trade.qty.toString(),
          },
          { headers: {
              "Authorization": `Bearer ${state.angelAuth}`,
              "Content-Type": "application/json",
              "X-PrivateKey": ENV.ANGEL_API_KEY
            }}
      );
    } catch (e) { log(`❌ Exit failed: ${e.message}`); }
  }

  const emoji = reason === "TARGET_HIT" ? "🎯" : reason === "SL_HIT" ? "🛑" : "⏰";
  const pnlEmoji = trade.exitPnL >= 0 ? "✅" : "❌";
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID,
      `${emoji} *${reason.replace(/_/g, " ")}* · ${trade.mode === "live" ? "💰 LIVE" : "📝 PAPER"}\n*${trade.symbol}*\nEntry ₹${trade.entry} → Exit ₹${exitPrice}\n${pnlEmoji} P&L: ${trade.exitPnL >= 0 ? "+" : ""}₹${trade.exitPnL.toFixed(0)}\nDay ${trade.mode} total: ₹${state.dayPnL[trade.mode].toFixed(0)}`,
      { parse_mode: "Markdown" });

  log(`${reason}: ${trade.symbol} · P&L: ₹${trade.exitPnL.toFixed(0)}`);

  if (state.dayPnL.live <= -CONFIG.DAILY_LOSS_CAP && !state.isHalted) {
    state.isHalted = true;
    await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `🛑 *DAILY LOSS CAP HIT*`, { parse_mode: "Markdown" });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN SCANNER
// ═══════════════════════════════════════════════════════════════════════════
async function runScan(verbose = false) {
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  if (mins < 555 || mins > 930) return;
  if (state.isHalted) return;

  state.scanCount++;
  state.lastScanTime = now;

  const results = { scanned: 0, noCandles: 0, inPos: 0, hold: 0, filtered: 0, alerted: 0 };

  for (const symbol of CONFIG.WATCHLIST) {
    results.scanned++;
    const candles = state.candleBuffer.get(symbol);
    if (!candles || candles.length < CONFIG.MIN_CANDLES) { results.noCandles++; continue; }
    if (state.openTrades.some(t => t.symbol === symbol && t.status === "open")) { results.inPos++; continue; }

    const sig = analyzeSignal(symbol, candles);
    if (!sig || sig.rejected) { results.noCandles++; continue; }
    if (sig.signal === "HOLD") { results.hold++; continue; }
    if (!sig.safeToTrade) { results.filtered++; continue; }

    results.alerted++;
    await sendSignalAlert(sig);
  }

  // Forced signal logic
  const curHour = now.getHours() + now.getMinutes()/60;
  if (state.signalsToday === 0 && !state.forcedSignalSent &&
      curHour >= CONFIG.FORCE_SIGNAL_AFTER_HOUR &&
      curHour <= CONFIG.FORCE_SIGNAL_MAX_HOUR) {
    log("🎯 No signal yet · finding best opportunity (relaxed mode)");
    let best = null;
    for (const symbol of CONFIG.WATCHLIST) {
      const candles = state.candleBuffer.get(symbol);
      if (!candles || candles.length < CONFIG.MIN_CANDLES) continue;
      if (state.openTrades.some(t => t.symbol === symbol && t.status === "open")) continue;
      const sig = analyzeSignal(symbol, candles, true);
      if (!sig || sig.signal === "HOLD") continue;
      if (!best || Math.abs(sig.score) > Math.abs(best.score)) best = sig;
    }
    if (best && best.safeToTrade) {
      state.forcedSignalSent = true;
      log(`🎯 FORCED: ${best.symbol} ${best.signal}`);
      await sendSignalAlert(best, true);
    }
  }

  if (state.scanCount % 20 === 1 || verbose) {
    log(`🔍 Scan #${state.scanCount} · ${results.scanned} stocks | ${results.noCandles} no-data | ${results.inPos} in-trade | ${results.hold} hold | ${results.filtered} filtered | ${results.alerted} alerted · total today: ${state.signalsToday}`);
  }
}

setInterval(() => runScan(), CONFIG.SCAN_INTERVAL_MS);

setInterval(() => {
  const now = new Date();
  if (now.getHours() === 9 && now.getMinutes() === 15) {
    state.signalsToday = 0;
    state.forcedSignalSent = false;
    state.dayPnL = { live: 0, paper: 0 };
    log("🌅 Daily counters reset");
  }
}, 60000);

// ═══════════════════════════════════════════════════════════════════════════
// STARTUP · FIXED ORDER: scrip master first, then everything else
// ═══════════════════════════════════════════════════════════════════════════
async function startup() {
  log("🚀 NSE TradeAI Bot v6.1 (CRITICAL FIX) starting...");
  log(`   Watchlist: ${CONFIG.WATCHLIST.length} stocks · Capital: ₹${CONFIG.CAPITAL.toLocaleString("en-IN")}`);
  log(`   SL ${CONFIG.SL_PCT*100}% · Target ${CONFIG.TARGET_PCT*100}%`);
  log(`   Live: ${CONFIG.LIVE_TRADING ? "✅ ON" : "❌ OFF (paper only)"}`);

  await initDB();
  await logEvent("STARTUP", "Bot v6.1 started");

  const { app, auth } = startAPI(3000);
  addAccountEndpoints(app, state, auth);

  const authOk = await authenticateAngel();
  if (!authOk) process.exit(1);

  // ═══ FIX: Load scrip master FIRST, before anything else ═══
  const scripOk = await loadScripMasterOnce();
  if (!scripOk) {
    log("❌ Cannot proceed without scrip master");
    await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, "❌ *Startup Failed*\nCannot download Angel scrip master. Will retry in 60s.", { parse_mode: "Markdown" });
    setTimeout(() => startup(), 60000);
    return;
  }

  // Resolve all tokens (now cached scrip master is in memory)
  log("🔑 Resolving all symbol tokens...");
  const tokens = [];
  const unresolved = [];
  for (const sym of CONFIG.WATCHLIST) {
    const t = await getSymbolToken(sym);
    if (t) tokens.push(t);
    else unresolved.push(sym);
  }
  log(`✓ Resolved ${tokens.length}/${CONFIG.WATCHLIST.length} tokens`);
  if (unresolved.length > 0) {
    log(`⚠️ Unresolved: ${unresolved.join(", ")}`);
  }

  // Pre-load historical candles
  log("📊 Pre-loading historical candles...");
  let totalLoaded = 0, successful = 0;
  for (const sym of CONFIG.WATCHLIST) {
    const count = await loadHistoricalCandles(sym);
    if (count > 0) { totalLoaded += count; successful++; }
    await new Promise(r => setTimeout(r, 250));
  }
  log(`✅ Pre-loaded ${totalLoaded} candles from ${successful}/${CONFIG.WATCHLIST.length} stocks`);

  // Start WebSocket
  await startWebSocket(tokens);

  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID,
      `🚀 *Bot v6.1 Online (FIXED)*\n━━━━━━━━━━━━━━\n✅ Scrip master: ${state.scripMaster.length} items\n✅ Tokens resolved: ${tokens.length}/${CONFIG.WATCHLIST.length}\n✅ Candles loaded: ${totalLoaded} (${successful} stocks)\n\n💰 Capital: ₹2,50,000\n📉 SL: ${CONFIG.SL_PCT*100}% · Target: ${CONFIG.TARGET_PCT*100}%\n\n${unresolved.length > 0 ? `⚠️ Skipped: ${unresolved.join(", ")}\n\n` : ""}${CONFIG.LIVE_TRADING ? "⚡ Live trading ON" : "📝 Paper mode"}\n\n/status · /diagnose · /scan`,
      { parse_mode: "Markdown" });

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
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, "⚠️ Shutting down");
  if (state.ws) state.ws.close();
  process.exit(0);
});

process.on("uncaughtException", async (err) => {
  log(`💥 Uncaught: ${err.message}`);
});
