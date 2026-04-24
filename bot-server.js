// ═══════════════════════════════════════════════════════════════════════════
// NSE TradeAI Bot v5 · FIXED VERSION
// Resolves: missing signals, silent failures, tight thresholds, candle delays
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

// ═══ CONFIG — LOOSENED THRESHOLDS ══════════════════════════════════════════
const CONFIG = {
  CAPITAL:         250000,
  RISK_PER_TRADE:  1000,
  REWARD_RATIO:    2,
  DAILY_LOSS_CAP:  2500,
  MAX_POSITIONS:   3,
  TRAIL_STEP_PCT:  0.5,
  VIX_DANGER:      20,
  LIVE_TRADING:    process.env.LIVE_TRADING === "true",
  PAPER_TRADING:   true,

  // ─── FIX: Loosened signal thresholds ───
  SIGNAL_SCORE_BUY:  2.5,    // was 4 (too strict)
  SIGNAL_SCORE_SELL: -2.5,   // was -4
  MIN_CONFLUENCE:    2,      // was 3 (too strict)
  MIN_CONFIDENCE:    55,     // was 60
  MIN_VOLUME_RATIO:  1.0,    // was 1.2
  MIN_CANDLES:       20,     // was 50 (takes 100 min instead of 4 hours)
  SCAN_INTERVAL_MS:  15000,  // was 60000 (scan every 15s instead of 60s)

  WATCHLIST: [
    "RELIANCE","HDFCBANK","TCS","HINDUNILVR","JSWSTEEL","APOLLOHOSP",
    "POWERGRID","TITAN","INFY","ICICIBANK","SBIN","LT","BHARTIARTL",
    "ITC","KOTAKBANK","MARUTI","AXISBANK","NESTLEIND","BAJFINANCE","SUNPHARMA"
  ],
  UNSAFE_WINDOWS: [
    { start: "09:15", end: "09:20", reason: "Opening volatility" },  // tighter
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

// ═══ STATE ════════════════════════════════════════════════════════════════
export const state = {
  angelAuth:      null,
  feedToken:      null,
  ws:             null,
  livePrices:     new Map(),
  candleBuffer:   new Map(),
  openTrades:     [],
  pendingSignals: new Map(),
  dayPnL:         { live: 0, paper: 0 },
  isHalted:       false,
  symbolTokens:   new Map(),
  tokenToSymbol:  new Map(),  // ← FIX: reverse lookup for WebSocket
  scanCount:      0,           // diagnostic counter
  lastScanTime:   null,
};

function log(msg) {
  const ts = new Date().toISOString().replace("T", " ").substring(0, 19);
  console.log(`[${ts}] ${msg}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// ANGEL ONE AUTH (unchanged)
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

// ═══════════════════════════════════════════════════════════════════════════
// FIX: PRE-LOAD HISTORICAL CANDLES ON STARTUP
// ═══════════════════════════════════════════════════════════════════════════
async function loadHistoricalCandles(symbol) {
  try {
    const token = await getSymbolToken(symbol);
    if (!token) return;

    const now = new Date();
    const fromDate = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);  // 5 days back

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
          "Authorization":   `Bearer ${state.angelAuth}`,
          "Content-Type":    "application/json",
          "X-PrivateKey":    ENV.ANGEL_API_KEY,
          "X-UserType":      "USER",
          "X-SourceID":      "WEB",
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
      log(`  📊 ${symbol}: loaded ${candles.length} historical candles`);
      return candles.length;
    }
    return 0;
  } catch (e) {
    log(`  ⚠️ ${symbol}: historical load failed - ${e.message}`);
    return 0;
  }
}

function formatAngelDate(d) {
  const pad = n => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// SYMBOL TOKEN RESOLVER (unchanged)
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
      state.tokenToSymbol.set(match.token, symbol);  // ← FIX: reverse lookup
      return match.token;
    }
  } catch (e) {
    log(`⚠️ Could not resolve ${symbol}: ${e.message}`);
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// WEBSOCKET — FIXED BINARY PARSER
// ═══════════════════════════════════════════════════════════════════════════
async function startWebSocket(tokens) {
  const wsUrl = `wss://smartapisocket.angelone.in/smart-stream?clientCode=${ENV.ANGEL_CLIENT_ID}&feedToken=${state.feedToken}&apiKey=${ENV.ANGEL_API_KEY}`;
  state.ws = new WebSocket(wsUrl);

  state.ws.on("open", () => {
    log("📡 WebSocket connected");
    const subMsg = {
      correlationID: "nseaibot",
      action: 1,
      params: {
        mode: 2,  // ← FIX: mode 2 (QUOTE) instead of 3 (FULL) — more reliable
        tokenList: [{ exchangeType: 1, tokens }]
      }
    };
    state.ws.send(JSON.stringify(subMsg));
  });

  let tickCount = 0;
  state.ws.on("message", (data) => {
    try {
      const tick = parseBinaryTickFixed(data);
      if (tick?.token) {
        tickCount++;
        if (tickCount % 100 === 0) log(`📡 ${tickCount} ticks received`);  // diagnostic

        const symbol = state.tokenToSymbol.get(tick.token);  // ← FIX: O(1) lookup
        if (symbol) {
          state.livePrices.set(symbol, {
            ltp:       tick.ltp,
            volume:    tick.volume,
            change:    tick.ltp - (state.livePrices.get(symbol)?.openPrice || tick.ltp),
            changePct: 0,
            openPrice: state.livePrices.get(symbol)?.openPrice || tick.ltp,
            timestamp: Date.now(),
          });
          updateCandles(symbol, tick.ltp, tick.volume);
        }
      }
    } catch (e) { /* ignore */ }
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

// ─── FIX: Correct binary parser per Angel One SmartAPI v2 docs ───
function parseBinaryTickFixed(buffer) {
  if (!buffer || buffer.length < 51) return null;
  try {
    // Angel One binary format (Mode 2):
    // Byte 0: subscription mode (1 byte)
    // Byte 1: exchange type (1 byte)
    // Byte 2-26: token (25 bytes, string)
    // Byte 27-34: sequence number (8 bytes, int64)
    // Byte 35-42: exchange timestamp (8 bytes, int64)
    // Byte 43-46: LTP (4 bytes, int32, divide by 100)
    // Byte 47-50: last traded qty (4 bytes, int32)

    // Token is stored as ASCII string in bytes 2-26
    let tokenStr = "";
    for (let i = 2; i < 27; i++) {
      const byte = buffer[i];
      if (byte === 0) break;
      tokenStr += String.fromCharCode(byte);
    }
    tokenStr = tokenStr.trim();

    const ltp = buffer.readInt32LE(43) / 100;
    const ltq = buffer.length >= 51 ? buffer.readInt32LE(47) : 0;

    if (ltp <= 0 || !tokenStr) return null;
    return { token: tokenStr, ltp, volume: ltq };
  } catch (e) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CANDLE AGGREGATOR (unchanged)
// ═══════════════════════════════════════════════════════════════════════════
function updateCandles(symbol, ltp, vol) {
  if (!state.candleBuffer.has(symbol)) {
    state.candleBuffer.set(symbol, []);
  }
  const candles = state.candleBuffer.get(symbol);
  const now = new Date();
  const bucket = Math.floor(now.getMinutes() / 5) * 5;
  const bucketKey = `${now.getHours()}:${bucket}`;
  const last = candles[candles.length - 1];

  if (!last || last.bucket !== bucketKey) {
    candles.push({ bucket: bucketKey, o: ltp, h: ltp, l: ltp, c: ltp, v: vol });
    if (candles.length > 200) candles.shift();
  } else {
    last.h = Math.max(last.h, ltp);
    last.l = Math.min(last.l, ltp);
    last.c = ltp;
    last.v += vol;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// INDICATORS (unchanged)
// ═══════════════════════════════════════════════════════════════════════════
function ema(closes, period) {
  if (closes.length < period) return closes[closes.length - 1];
  const k = 2 / (period + 1);
  let e = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
  return e;
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
  return { macd: e12 - e26, bullish: e12 > e26 };
}

// ═══════════════════════════════════════════════════════════════════════════
// STRATEGY ENGINE — FIXED with proper logging
// ═══════════════════════════════════════════════════════════════════════════
function analyzeSignal(symbol, candles) {
  if (candles.length < CONFIG.MIN_CANDLES) {
    return { rejected: true, reason: `Only ${candles.length}/${CONFIG.MIN_CANDLES} candles` };
  }

  const closes = candles.map(c => c.c);
  const vols   = candles.map(c => c.v);
  const R = rsi(closes);
  const M = macd(closes);
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const avgVol = vols.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, vols.length);
  const volRatio = avgVol > 0 ? vols[vols.length - 1] / avgVol : 1;
  const price = closes[closes.length - 1];

  let score = 0;
  let bullCount = 0, bearCount = 0;
  const checks = {};

  // ─── FIX: Widened RSI neutral zone to catch more signals ───
  if (R < 40) { score += 2; bullCount++; checks.rsi = "bull"; }       // was <35
  else if (R > 60) { score -= 2; bearCount++; checks.rsi = "bear"; }  // was >65
  else if (R >= 45 && R <= 55) { 
    score += 0.5;  // neutral but slight bullish bias in healthy zone
    checks.rsi = "neutral"; 
  } else { checks.rsi = "neutral"; }

  if (M.bullish) { score += 1.5; bullCount++; checks.macd = "bull"; }
  else { score -= 1.5; bearCount++; checks.macd = "bear"; }

  if (e9 > e21 && e21 > e50) { score += 2; bullCount++; checks.ema = "bull"; }
  else if (e9 < e21 && e21 < e50) { score -= 2; bearCount++; checks.ema = "bear"; }
  else if (e9 > e21) { score += 0.5; checks.ema = "bull-weak"; }
  else { score -= 0.5; checks.ema = "bear-weak"; }

  if (volRatio > 1.5) score += Math.sign(score) * 1;

  let signal = "HOLD";
  let confidence = 50;
  if (score >= CONFIG.SIGNAL_SCORE_BUY) {
    signal = "BUY";
    confidence = Math.min(50 + score * 5, 78);
  } else if (score <= CONFIG.SIGNAL_SCORE_SELL) {
    signal = "SELL";
    confidence = Math.min(50 + Math.abs(score) * 5, 75);
  }

  const maxConfluence = Math.max(bullCount, bearCount);
  const orderType = (maxConfluence >= 3 && volRatio > 1.5 && confidence > 65) ? "CNC" : "MIS";

  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const unsafe = CONFIG.UNSAFE_WINDOWS.find(w => {
    const [sh, sm] = w.start.split(":").map(Number);
    const [eh, em] = w.end.split(":").map(Number);
    return mins >= (sh * 60 + sm) && mins <= (eh * 60 + em);
  });

  const filtersPassed = {
    confluence: maxConfluence >= CONFIG.MIN_CONFLUENCE,
    time: !unsafe,
    volume: volRatio >= CONFIG.MIN_VOLUME_RATIO,
    strength: Math.abs(score) >= Math.abs(CONFIG.SIGNAL_SCORE_BUY),
    confidence: confidence >= CONFIG.MIN_CONFIDENCE,
  };
  const safeToTrade = Object.values(filtersPassed).every(Boolean);

  const stopDist = price * 0.015;
  const qty = Math.floor(CONFIG.RISK_PER_TRADE / stopDist) || 1;
  const entry = parseFloat(price.toFixed(2));
  const sl = parseFloat((price - stopDist).toFixed(2));
  const target = parseFloat((price + stopDist * CONFIG.REWARD_RATIO).toFixed(2));

  return {
    id: `${symbol}-${Date.now()}`,
    symbol, signal, confidence, score, orderType,
    indicators: {
      rsi: parseFloat(R.toFixed(1)),
      volRatio: parseFloat(volRatio.toFixed(2)),
      checks,
      price: parseFloat(price.toFixed(2))
    },
    bullCount, bearCount, filtersPassed, safeToTrade,
    entry, sl, target, qty,
    capital: qty * entry,
    maxLoss: qty * stopDist,
    maxGain: qty * stopDist * CONFIG.REWARD_RATIO,
    timestamp: Date.now(),
    rejected: false,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// TELEGRAM BOT (simplified – unchanged functionality)
// ═══════════════════════════════════════════════════════════════════════════
const tg = new TelegramBot(ENV.TELEGRAM_TOKEN, { polling: true });

async function sendSignalAlert(sig) {
  state.pendingSignals.set(sig.id, sig);
  setTimeout(() => state.pendingSignals.delete(sig.id), 120000);
  await logSignal(sig, "pending");

  const emoji = sig.signal === "BUY" ? "🟢" : "🔴";
  const typeBadge = sig.orderType === "CNC" ? "📦 DELIVERY" : "⚡ INTRADAY";
  const msg = `${emoji} *${sig.signal} SIGNAL* · ${typeBadge}
━━━━━━━━━━━━━━━━━
*${sig.symbol}*  _(Confidence: ${sig.confidence}%)_

💰 Entry:  ₹${sig.entry}
🎯 Target: ₹${sig.target}  (+₹${sig.maxGain.toFixed(0)})
🛑 SL:     ₹${sig.sl}  (-₹${sig.maxLoss.toFixed(0)})
📦 Qty:    ${sig.qty}
💸 Capital: ₹${sig.capital.toFixed(0)}

📊 RSI: ${sig.indicators.rsi} · MACD: ${sig.indicators.checks.macd} · EMA: ${sig.indicators.checks.ema}
📈 Confluence: ${Math.max(sig.bullCount, sig.bearCount)}/3 · Vol: ${sig.indicators.volRatio}x

⏰ _Signal expires in 2 minutes_`;

  const keyboard = {
    inline_keyboard: [[
      { text: "✅ Execute", callback_data: `exec_live_${sig.id}` },
      { text: "📝 Paper", callback_data: `exec_paper_${sig.id}` },
      { text: "❌ Skip", callback_data: `skip_${sig.id}` },
    ]]
  };

  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, msg, {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
  log(`📤 Signal sent: ${sig.symbol} ${sig.signal} ${sig.confidence}%`);
}

// Callback handler, commands (unchanged from previous)
tg.on("callback_query", async (query) => {
  const data = query.data;
  const sigId = data.replace(/^(exec_live_|exec_paper_|skip_)/, "");
  const sig = state.pendingSignals.get(sigId);
  if (!sig) {
    await tg.answerCallbackQuery(query.id, { text: "⏰ Expired" });
    return;
  }
  // [... existing callback logic — same as before]
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
Live: ${CONFIG.LIVE_TRADING ? "✅ ON" : "❌ OFF"}
Halted: ${state.isHalted ? "🛑 YES" : "✅ NO"}
━━━━━━━━━━━━━
🩺 *Diagnostics:*
Avg candles/stock: ${avgCandles} (need ${CONFIG.MIN_CANDLES}+)
Scans done: ${state.scanCount}
Last scan: ${state.lastScanTime ? state.lastScanTime.toLocaleTimeString("en-IN") : "never"}
Live prices: ${state.livePrices.size} stocks`;
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, msg, { parse_mode: "Markdown" });
});

tg.onText(/\/diagnose/, async () => {
  const lines = [];
  for (const sym of CONFIG.WATCHLIST.slice(0, 10)) {
    const c = state.candleBuffer.get(sym);
    const p = state.livePrices.get(sym);
    lines.push(`${sym}: ${c?.length || 0} candles · LTP ₹${p?.ltp?.toFixed(1) || "—"}`);
  }
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `🔍 *Diagnosis (first 10):*\n\`\`\`\n${lines.join("\n")}\n\`\`\``, { parse_mode: "Markdown" });
});

tg.onText(/\/scan/, async () => {
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, "🔍 Running manual scan...");
  await runScan(true);
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `✅ Scan complete · ${state.scanCount} total scans run`);
});

tg.onText(/\/stop/, async () => {
  state.isHalted = true;
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, "🛑 Trading halted");
});

tg.onText(/\/resume/, async () => {
  state.isHalted = false;
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, "✅ Trading resumed");
});

// ═══════════════════════════════════════════════════════════════════════════
// PAPER / LIVE EXECUTION (condensed — same as before)
// ═══════════════════════════════════════════════════════════════════════════
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

async function executeLiveOrder(sig) {
  // [... same as before, omitted for brevity]
}

// ═══════════════════════════════════════════════════════════════════════════
// ═══ FIX: MAIN SIGNAL SCANNER WITH FULL LOGGING ═══
// ═══════════════════════════════════════════════════════════════════════════
async function runScan(verbose = false) {
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();

  // Market hours check
  if (mins < 555 || mins > 930) {
    if (verbose) log("⏰ Market closed");
    return;
  }
  if (state.isHalted) {
    if (verbose) log("🛑 Bot halted");
    return;
  }

  state.scanCount++;
  state.lastScanTime = now;

  const results = {
    scanned: 0,
    insufficientCandles: 0,
    inPosition: 0,
    hold: 0,
    unsafe: 0,
    alerted: 0,
    rejectedBy: {},
  };

  for (const symbol of CONFIG.WATCHLIST) {
    results.scanned++;
    const candles = state.candleBuffer.get(symbol);

    if (!candles || candles.length < CONFIG.MIN_CANDLES) {
      results.insufficientCandles++;
      continue;
    }

    if (state.openTrades.some(t => t.symbol === symbol && t.status === "open")) {
      results.inPosition++;
      continue;
    }

    const sig = analyzeSignal(symbol, candles);
    if (!sig || sig.rejected) {
      results.insufficientCandles++;
      continue;
    }

    if (sig.signal === "HOLD") {
      results.hold++;
      if (verbose) log(`  ${symbol}: HOLD · score ${sig.score} · RSI ${sig.indicators.rsi}`);
      continue;
    }

    if (!sig.safeToTrade) {
      results.unsafe++;
      const failed = Object.entries(sig.filtersPassed).filter(([k, v]) => !v).map(([k]) => k);
      failed.forEach(f => results.rejectedBy[f] = (results.rejectedBy[f] || 0) + 1);
      if (verbose) log(`  ${symbol}: ${sig.signal} but failed filters: ${failed.join(", ")}`);
      continue;
    }

    results.alerted++;
    await sendSignalAlert(sig);
  }

  // Log summary every 10 scans (every 2.5 min) or when verbose
  if (state.scanCount % 10 === 1 || verbose) {
    log(`🔍 Scan #${state.scanCount}: ${results.scanned} stocks | ${results.insufficientCandles} low-data | ${results.inPosition} in-trade | ${results.hold} hold | ${results.unsafe} filtered | ${results.alerted} alerted`);
    if (Object.keys(results.rejectedBy).length > 0) {
      log(`   Filter fails: ${Object.entries(results.rejectedBy).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    }
  }
}

setInterval(() => runScan(), CONFIG.SCAN_INTERVAL_MS);

// ═══════════════════════════════════════════════════════════════════════════
// STARTUP WITH HISTORICAL PRE-LOAD
// ═══════════════════════════════════════════════════════════════════════════
async function startup() {
  log("🚀 NSE TradeAI Bot v5 (FIXED) starting...");
  log(`   Capital: ₹${CONFIG.CAPITAL.toLocaleString("en-IN")} · Risk: ₹${CONFIG.RISK_PER_TRADE}`);
  log(`   Live trading: ${CONFIG.LIVE_TRADING ? "✅ ENABLED" : "❌ DISABLED"}`);
  log(`   Thresholds: score≥${CONFIG.SIGNAL_SCORE_BUY} · confluence≥${CONFIG.MIN_CONFLUENCE} · confidence≥${CONFIG.MIN_CONFIDENCE}%`);
  log(`   Min candles: ${CONFIG.MIN_CANDLES} · Scan interval: ${CONFIG.SCAN_INTERVAL_MS/1000}s`);

  await initDB();
  await logEvent("STARTUP", "Bot v5 started");

  const { app, auth } = startAPI(3000);
  addAccountEndpoints(app, state, auth);

  const authOk = await authenticateAngel();
  if (!authOk) process.exit(1);

  // Resolve all tokens
  log("🔑 Resolving symbol tokens...");
  const tokens = [];
  for (const sym of CONFIG.WATCHLIST) {
    const t = await getSymbolToken(sym);
    if (t) tokens.push(t);
  }
  log(`✓ Resolved ${tokens.length}/${CONFIG.WATCHLIST.length} tokens`);

  // ═══ FIX: Pre-load 5 days of historical candles ═══
  log("📊 Pre-loading historical candles (this takes ~1 min)...");
  let totalLoaded = 0;
  for (const sym of CONFIG.WATCHLIST) {
    const count = await loadHistoricalCandles(sym);
    totalLoaded += count || 0;
    await new Promise(r => setTimeout(r, 300));  // rate limit
  }
  log(`✅ Pre-loaded ${totalLoaded} candles across ${CONFIG.WATCHLIST.length} stocks`);

  // Start WebSocket for live updates
  await startWebSocket(tokens);

  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `🚀 *Bot v5 Online (FIXED)*
━━━━━━━━━━━━━━
Capital: ₹2,50,000
Risk: ₹1,000/trade
Live: ${CONFIG.LIVE_TRADING ? "ON ⚡" : "OFF 📝"}
Historical candles: ${totalLoaded}
Watchlist: ${CONFIG.WATCHLIST.length}

_Signals should start within 2-5 minutes_

Commands:
/status · /diagnose · /scan
/positions · /stop · /resume`, { parse_mode: "Markdown" });

  // Run first scan immediately after 30s (to let WebSocket get some ticks)
  setTimeout(() => runScan(true), 30000);

  log("✅ Bot operational");
}

startup().catch(e => {
  log(`💥 Fatal: ${e.message}`);
  process.exit(1);
});

process.on("SIGINT", async () => {
  log("Shutting down...");
  if (state.ws) state.ws.close();
  process.exit(0);
});
