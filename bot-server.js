// ═══════════════════════════════════════════════════════════════════════════
// NSE TradeAI Bot v4 — Semi-Auto Trading with Telegram
// Capital: ₹2,50,000 · Risk: ₹1,000/trade · Hybrid Paper + Live · CNC + MIS
// ═══════════════════════════════════════════════════════════════════════════

import axios from "axios";
import { authenticator } from "otplib";
import TelegramBot from "node-telegram-bot-api";
import WebSocket from "ws";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ─── CONFIG ─────────────────────────────────────────────────────────────────
const CONFIG = {
  CAPITAL:         250000,
  RISK_PER_TRADE:  1000,          // ₹1,000 for first 2 weeks, then scale
  REWARD_RATIO:    2,             // 1:2 risk-reward
  DAILY_LOSS_CAP:  2500,          // auto-halt after this loss
  WEEKLY_LOSS_CAP: 7500,
  MAX_POSITIONS:   3,
  TRAIL_STEP_PCT:  0.5,           // trail SL by 0.5%
  VIX_DANGER:      20,
  LIVE_TRADING:    process.env.LIVE_TRADING === "true",  // MUST be explicitly enabled
  PAPER_TRADING:   true,          // always runs in parallel
  WATCHLIST: [
    "RELIANCE","HDFCBANK","TCS","HINDUNILVR","JSWSTEEL","APOLLOHOSP",
    "POWERGRID","TITAN","INFY","ICICIBANK","SBIN","LT","BHARTIARTL",
    "ITC","KOTAKBANK","MARUTI","AXISBANK","NESTLEIND","BAJFINANCE","SUNPHARMA"
  ],
  UNSAFE_WINDOWS: [
    { start: "09:15", end: "09:30", reason: "Opening volatility" },
    { start: "15:15", end: "15:30", reason: "Closing square-off" }
  ],
};

const ENV = {
  ANGEL_CLIENT_ID:  process.env.ANGEL_CLIENT_ID,
  ANGEL_API_KEY:    process.env.ANGEL_API_KEY,
  ANGEL_MPIN:       process.env.ANGEL_MPIN,
  ANGEL_TOTP_TOKEN: process.env.ANGEL_TOTP_TOKEN,  // TOTP secret (not current code)
  TELEGRAM_TOKEN:   process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
};

// ─── STATE ──────────────────────────────────────────────────────────────────
const state = {
  angelAuth:      null,
  feedToken:      null,
  refreshToken:   null,
  ws:             null,
  livePrices:     new Map(),
  candleBuffer:   new Map(),         // symbol → [candles]
  openTrades:     [],                // both paper + live
  pendingSignals: new Map(),         // signalId → signal (awaiting Telegram tap)
  dayPnL:         { live: 0, paper: 0 },
  totalTrades:    { live: 0, paper: 0 },
  isHalted:       false,
};

// ═══════════════════════════════════════════════════════════════════════════
// 1. ANGEL ONE AUTHENTICATION
// ═══════════════════════════════════════════════════════════════════════════
async function authenticateAngel() {
  log("🔐 Authenticating with Angel One...");
  try {
    const totp = authenticator.generate(ENV.ANGEL_TOTP_TOKEN);
    const res = await axios.post(
      "https://apiconnect.angelbroking.com/rest/auth/angelbroking/user/v1/loginByPassword",
      {
        clientcode: ENV.ANGEL_CLIENT_ID,
        password:   ENV.ANGEL_MPIN,
        totp:       totp,
      },
      {
        headers: {
          "Content-Type":        "application/json",
          "Accept":              "application/json",
          "X-UserType":          "USER",
          "X-SourceID":          "WEB",
          "X-ClientLocalIP":     "192.168.1.1",
          "X-ClientPublicIP":    "103.0.0.1",
          "X-MACAddress":        "00:00:00:00:00:00",
          "X-PrivateKey":        ENV.ANGEL_API_KEY,
        },
      }
    );
    if (res.data?.data?.jwtToken) {
      state.angelAuth    = res.data.data.jwtToken;
      state.feedToken    = res.data.data.feedToken;
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

// ═══════════════════════════════════════════════════════════════════════════
// 2. WEBSOCKET LIVE PRICE FEED
// ═══════════════════════════════════════════════════════════════════════════
async function startWebSocket(tokens) {
  const wsUrl = `wss://smartapisocket.angelone.in/smart-stream?clientCode=${ENV.ANGEL_CLIENT_ID}&feedToken=${state.feedToken}&apiKey=${ENV.ANGEL_API_KEY}`;
  state.ws = new WebSocket(wsUrl);

  state.ws.on("open", () => {
    log("📡 WebSocket connected · subscribing to watchlist");
    const subMsg = {
      correlationID: "nseaibot",
      action: 1,
      params: {
        mode: 3,  // snap quote
        tokenList: [{ exchangeType: 1, tokens }]
      }
    };
    state.ws.send(JSON.stringify(subMsg));
  });

  state.ws.on("message", (data) => {
    try {
      const tick = parseBinaryTick(data);
      if (tick?.symbol) {
        state.livePrices.set(tick.symbol, {
          ltp:       tick.ltp,
          volume:    tick.volume,
          timestamp: Date.now(),
        });
        updateCandles(tick.symbol, tick.ltp, tick.volume);
      }
    } catch (e) { /* swallow tick parse errors */ }
  });

  state.ws.on("close", () => {
    log("⚠️ WebSocket closed · reconnecting in 5s");
    setTimeout(() => startWebSocket(tokens), 5000);
  });

  state.ws.on("error", (e) => log(`⚠️ WS error: ${e.message}`));

  // Heartbeat every 30s
  setInterval(() => {
    if (state.ws?.readyState === WebSocket.OPEN) state.ws.ping();
  }, 30000);
}

function parseBinaryTick(buffer) {
  // Simplified — real Angel binary parser is more detailed
  // See: https://smartapi.angelbroking.com/docs/WebSocket2
  if (buffer.length < 51) return null;
  try {
    const ltp = buffer.readInt32LE(43) / 100;
    const vol = buffer.readInt32LE(51);
    // Symbol lookup from token → done via subscription map (stored separately)
    return { ltp, volume: vol };
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. CANDLE AGGREGATOR — builds 5-min candles from live ticks
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
    if (candles.length > 100) candles.shift();
  } else {
    last.h = Math.max(last.h, ltp);
    last.l = Math.min(last.l, ltp);
    last.c = ltp;
    last.v += vol;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. TECHNICAL INDICATORS
// ═══════════════════════════════════════════════════════════════════════════
function ema(closes, period) {
  const k = 2 / (period + 1);
  let e = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
  return e;
}

function rsi(closes, period = 14) {
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
// 5. STRATEGY ENGINE — decides MIS vs CNC based on signal strength
// ═══════════════════════════════════════════════════════════════════════════
function analyzeSignal(symbol, candles) {
  if (candles.length < 50) return null;
  const closes = candles.map(c => c.c);
  const vols   = candles.map(c => c.v);
  const R = rsi(closes);
  const M = macd(closes);
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const avgVol = vols.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volRatio = vols[vols.length - 1] / avgVol;
  const price = closes[closes.length - 1];

  // Score
  let score = 0;
  let bullCount = 0, bearCount = 0;
  const checks = {};

  if (R < 35) { score += 2.5; bullCount++; checks.rsi = "bull"; }
  else if (R > 65) { score -= 2.5; bearCount++; checks.rsi = "bear"; }
  else { checks.rsi = "neutral"; }

  if (M.bullish) { score += 2; bullCount++; checks.macd = "bull"; }
  else { score -= 2; bearCount++; checks.macd = "bear"; }

  if (e9 > e21 && e21 > e50) { score += 2; bullCount++; checks.ema = "bull"; }
  else if (e9 < e21 && e21 < e50) { score -= 2; bearCount++; checks.ema = "bear"; }
  else { checks.ema = "neutral"; }

  if (volRatio > 1.5) score += Math.sign(score) * 1;

  let signal = "HOLD";
  let confidence = 50;
  if (score >= 4) { signal = "BUY"; confidence = Math.min(45 + score * 4, 75); }
  else if (score <= -4) { signal = "SELL"; confidence = Math.min(45 + Math.abs(score) * 4, 73); }

  // CNC vs MIS decision
  const maxConfluence = Math.max(bullCount, bearCount);
  const orderType = (maxConfluence === 3 && volRatio > 1.5 && confidence > 60) ? "CNC" : "MIS";
  // CNC for strong signals (3/3 confluence + strong volume + high confidence)
  // MIS for weaker but tradeable signals

  // Time window check
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const unsafe = CONFIG.UNSAFE_WINDOWS.find(w => {
    const [sh, sm] = w.start.split(":").map(Number);
    const [eh, em] = w.end.split(":").map(Number);
    return mins >= (sh * 60 + sm) && mins <= (eh * 60 + em);
  });

  const filtersPassed = {
    confluence: maxConfluence >= 3,
    time: !unsafe,
    volume: volRatio > 1.2,
    strength: Math.abs(score) >= 4,
  };
  const safeToTrade = Object.values(filtersPassed).every(Boolean);

  // Position sizing
  const stopDist = price * 0.015;  // 1.5% stop
  const qty = Math.floor(CONFIG.RISK_PER_TRADE / stopDist);
  const entry = parseFloat(price.toFixed(2));
  const sl = parseFloat((price - stopDist).toFixed(2));
  const target = parseFloat((price + stopDist * CONFIG.REWARD_RATIO).toFixed(2));

  return {
    id: `${symbol}-${Date.now()}`,
    symbol, signal, confidence, score, orderType,
    indicators: { rsi: R.toFixed(1), volRatio: volRatio.toFixed(2), checks },
    bullCount, bearCount, filtersPassed, safeToTrade,
    entry, sl, target, qty,
    capital: qty * entry,
    maxLoss: qty * stopDist,
    maxGain: qty * stopDist * CONFIG.REWARD_RATIO,
    timestamp: Date.now(),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. TELEGRAM BOT — sends alerts with Execute/Skip buttons
// ═══════════════════════════════════════════════════════════════════════════
const tg = new TelegramBot(ENV.TELEGRAM_TOKEN, { polling: true });

async function sendSignalAlert(sig) {
  state.pendingSignals.set(sig.id, sig);
  // Auto-expire signal after 2 minutes
  setTimeout(() => state.pendingSignals.delete(sig.id), 120000);

  const emoji = sig.signal === "BUY" ? "🟢" : "🔴";
  const typeBadge = sig.orderType === "CNC" ? "📦 DELIVERY" : "⚡ INTRADAY";
  const msg = `${emoji} *${sig.signal} SIGNAL* · ${typeBadge}
━━━━━━━━━━━━━━━━━
*${sig.symbol}*  _(Confidence: ${sig.confidence}%)_

💰 Entry:  ₹${sig.entry}
🎯 Target: ₹${sig.target}  (+₹${sig.maxGain.toFixed(0)})
🛑 SL:     ₹${sig.sl}  (-₹${sig.maxLoss.toFixed(0)})
📦 Qty:    ${sig.qty} shares
💸 Capital: ₹${sig.capital.toFixed(0)}

📊 *Technicals:*
• RSI: ${sig.indicators.rsi}
• MACD: ${sig.indicators.checks.macd === "bull" ? "Bullish ✓" : "Bearish ✗"}
• EMA Trend: ${sig.indicators.checks.ema}
• Volume: ${sig.indicators.volRatio}x avg
• Confluence: ${Math.max(sig.bullCount, sig.bearCount)}/3

⏰ _Signal expires in 2 minutes_`;

  const keyboard = {
    inline_keyboard: [[
      { text: "✅ Execute (Live)", callback_data: `exec_live_${sig.id}` },
      { text: "📝 Paper Only", callback_data: `exec_paper_${sig.id}` },
      { text: "❌ Skip", callback_data: `skip_${sig.id}` },
    ]]
  };

  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, msg, {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
}

// Handle button taps
tg.on("callback_query", async (query) => {
  const [action, mode, ...rest] = query.data.split("_");
  const sigId = rest.join("_") || query.data.replace("skip_", "");
  const sig = state.pendingSignals.get(sigId) || state.pendingSignals.get(sigId.replace("skip_", ""));

  if (!sig) {
    await tg.answerCallbackQuery(query.id, { text: "⏰ Signal expired" });
    await tg.editMessageText("⏰ Signal expired · no action taken", {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
    });
    return;
  }

  if (query.data.startsWith("skip_")) {
    await tg.answerCallbackQuery(query.id, { text: "Skipped" });
    await tg.editMessageText(`❌ Skipped: ${sig.symbol} ${sig.signal}`, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
    });
    state.pendingSignals.delete(sig.id);
    return;
  }

  if (query.data.startsWith("exec_live_")) {
    if (!CONFIG.LIVE_TRADING) {
      await tg.answerCallbackQuery(query.id, { text: "⚠️ Live trading disabled in config" });
      return;
    }
    if (state.isHalted) {
      await tg.answerCallbackQuery(query.id, { text: "🛑 Trading halted · loss limit hit" });
      return;
    }
    const activeLive = state.openTrades.filter(t => t.mode === "live" && t.status === "open").length;
    if (activeLive >= CONFIG.MAX_POSITIONS) {
      await tg.answerCallbackQuery(query.id, { text: `Max ${CONFIG.MAX_POSITIONS} positions reached` });
      return;
    }

    await executeLiveOrder(sig);
    await tg.answerCallbackQuery(query.id, { text: "✅ Order placed" });
    await tg.editMessageText(`✅ *EXECUTED LIVE* · ${sig.symbol}\n${sig.signal} @ ₹${sig.entry} · Qty ${sig.qty}\n_${sig.orderType} order placed · Trailing SL active_`, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      parse_mode: "Markdown",
    });
  }

  if (query.data.startsWith("exec_paper_")) {
    executePaperTrade(sig);
    await tg.answerCallbackQuery(query.id, { text: "📝 Paper trade opened" });
    await tg.editMessageText(`📝 *PAPER TRADE* · ${sig.symbol}\n${sig.signal} @ ₹${sig.entry} · Qty ${sig.qty}\n_Tracking virtually_`, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      parse_mode: "Markdown",
    });
  }
});

// Telegram commands
tg.onText(/\/status/, async () => {
  const liveActive = state.openTrades.filter(t => t.mode === "live" && t.status === "open").length;
  const paperActive = state.openTrades.filter(t => t.mode === "paper" && t.status === "open").length;
  const msg = `📊 *Bot Status*
━━━━━━━━━━━━━
Live P&L today: ${state.dayPnL.live >= 0 ? "+" : ""}₹${state.dayPnL.live.toFixed(0)}
Paper P&L today: ${state.dayPnL.paper >= 0 ? "+" : ""}₹${state.dayPnL.paper.toFixed(0)}
Live positions: ${liveActive}/${CONFIG.MAX_POSITIONS}
Paper positions: ${paperActive}
Live trading: ${CONFIG.LIVE_TRADING ? "✅ ON" : "❌ OFF"}
Halted: ${state.isHalted ? "🛑 YES" : "✅ NO"}
Total signals today: ${state.totalTrades.live + state.totalTrades.paper}`;
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, msg, { parse_mode: "Markdown" });
});

tg.onText(/\/stop/, async () => {
  state.isHalted = true;
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, "🛑 *KILL SWITCH ACTIVATED*\nAll new trades blocked. Active positions will continue with trailing SL.", { parse_mode: "Markdown" });
});

tg.onText(/\/resume/, async () => {
  state.isHalted = false;
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, "✅ Trading resumed");
});

tg.onText(/\/positions/, async () => {
  const active = state.openTrades.filter(t => t.status === "open");
  if (active.length === 0) return tg.sendMessage(ENV.TELEGRAM_CHAT_ID, "📭 No open positions");
  const msg = active.map(t => {
    const curPrice = state.livePrices.get(t.symbol)?.ltp || t.entry;
    const pnl = (curPrice - t.entry) * t.qty;
    return `${t.mode === "live" ? "💰" : "📝"} *${t.symbol}* (${t.orderType})
Entry: ₹${t.entry} · Now: ₹${curPrice.toFixed(2)}
SL: ₹${t.currentSL} · Target: ₹${t.target}
P&L: ${pnl >= 0 ? "+" : ""}₹${pnl.toFixed(0)}`;
  }).join("\n━━━━━━━━━━━━━\n");
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, msg, { parse_mode: "Markdown" });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. ORDER EXECUTION
// ═══════════════════════════════════════════════════════════════════════════
async function executeLiveOrder(sig) {
  try {
    const orderPayload = {
      variety:         "NORMAL",
      tradingsymbol:   `${sig.symbol}-EQ`,
      symboltoken:     await getSymbolToken(sig.symbol),
      transactiontype: sig.signal,
      exchange:        "NSE",
      ordertype:       "MARKET",
      producttype:     sig.orderType === "CNC" ? "DELIVERY" : "INTRADAY",
      duration:        "DAY",
      quantity:        sig.qty.toString(),
    };

    const res = await axios.post(
      "https://apiconnect.angelbroking.com/rest/secure/angelbroking/order/v1/placeOrder",
      orderPayload,
      {
        headers: {
          "Authorization":   `Bearer ${state.angelAuth}`,
          "Content-Type":    "application/json",
          "X-PrivateKey":    ENV.ANGEL_API_KEY,
          "X-UserType":      "USER",
          "X-SourceID":      "WEB",
        }
      }
    );

    if (res.data?.status) {
      const trade = {
        ...sig,
        mode:       "live",
        orderId:    res.data.data.orderid,
        currentSL:  sig.sl,
        currentPrice: sig.entry,
        status:     "open",
        openedAt:   new Date(),
        trailed:    false,
      };
      state.openTrades.push(trade);
      state.totalTrades.live++;
      log(`✅ LIVE ORDER: ${sig.symbol} ${sig.signal} ${sig.qty} @ ₹${sig.entry} · OrderID: ${res.data.data.orderid}`);
    }
  } catch (e) {
    log(`❌ Order failed: ${e.message}`);
    await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `⚠️ Order failed: ${sig.symbol}\nError: ${e.message}`);
  }
}

function executePaperTrade(sig) {
  state.openTrades.push({
    ...sig,
    mode:       "paper",
    currentSL:  sig.sl,
    currentPrice: sig.entry,
    status:     "open",
    openedAt:   new Date(),
    trailed:    false,
  });
  state.totalTrades.paper++;
  log(`📝 PAPER: ${sig.symbol} ${sig.signal} ${sig.qty} @ ₹${sig.entry}`);
}

async function getSymbolToken(symbol) {
  // Load from Angel One scrip master JSON (cached)
  // Full list: https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json
  const cachePath = "./scrip-master.json";
  let master;
  if (fs.existsSync(cachePath)) {
    master = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  } else {
    const res = await axios.get("https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json");
    master = res.data;
    fs.writeFileSync(cachePath, JSON.stringify(master));
  }
  const match = master.find(s => s.symbol === `${symbol}-EQ` && s.exch_seg === "NSE");
  return match?.token || "";
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. TRAILING STOP-LOSS ENGINE
// ═══════════════════════════════════════════════════════════════════════════
setInterval(async () => {
  for (const trade of state.openTrades.filter(t => t.status === "open")) {
    const curPrice = state.livePrices.get(trade.symbol)?.ltp;
    if (!curPrice) continue;
    trade.currentPrice = curPrice;

    // Trail SL up
    const gainFromEntry = curPrice - trade.entry;
    if (gainFromEntry > 0) {
      const newSL = parseFloat((trade.sl + gainFromEntry).toFixed(2));
      if (newSL > trade.currentSL) {
        trade.currentSL = newSL;
        trade.trailed = true;
      }
    }

    // Check SL hit
    if (curPrice <= trade.currentSL) {
      await closeTrade(trade, "SL_HIT", trade.currentSL);
    }
    // Check Target hit
    else if (curPrice >= trade.target) {
      await closeTrade(trade, "TARGET_HIT", trade.target);
    }
    // Auto-square MIS by 3:15 PM
    else if (trade.orderType === "MIS" && new Date().getHours() === 15 && new Date().getMinutes() >= 15) {
      await closeTrade(trade, "EOD_SQUARE_OFF", curPrice);
    }
  }
}, 3000);

async function closeTrade(trade, reason, exitPrice) {
  trade.status    = "closed";
  trade.exitPrice = exitPrice;
  trade.exitReason = reason;
  trade.exitPnL   = (exitPrice - trade.entry) * trade.qty;
  trade.closedAt  = new Date();

  // Update day P&L
  state.dayPnL[trade.mode] += trade.exitPnL;

  // Live exit order
  if (trade.mode === "live" && CONFIG.LIVE_TRADING) {
    try {
      await axios.post(
        "https://apiconnect.angelbroking.com/rest/secure/angelbroking/order/v1/placeOrder",
        {
          variety:         "NORMAL",
          tradingsymbol:   `${trade.symbol}-EQ`,
          symboltoken:     await getSymbolToken(trade.symbol),
          transactiontype: trade.signal === "BUY" ? "SELL" : "BUY",
          exchange:        "NSE",
          ordertype:       "MARKET",
          producttype:     trade.orderType === "CNC" ? "DELIVERY" : "INTRADAY",
          duration:        "DAY",
          quantity:        trade.qty.toString(),
        },
        { headers: { "Authorization": `Bearer ${state.angelAuth}`, "Content-Type": "application/json", "X-PrivateKey": ENV.ANGEL_API_KEY } }
      );
    } catch (e) {
      log(`❌ Exit order failed: ${e.message}`);
    }
  }

  // Telegram alert
  const emoji = reason === "TARGET_HIT" ? "🎯" : reason === "SL_HIT" ? "🛑" : "⏰";
  const pnlEmoji = trade.exitPnL >= 0 ? "✅" : "❌";
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `${emoji} *${reason.replace("_", " ")}* · ${trade.mode === "live" ? "💰 LIVE" : "📝 PAPER"}
*${trade.symbol}*
Entry: ₹${trade.entry} → Exit: ₹${exitPrice}
${pnlEmoji} P&L: ${trade.exitPnL >= 0 ? "+" : ""}₹${trade.exitPnL.toFixed(0)}
Day ${trade.mode} total: ₹${state.dayPnL[trade.mode].toFixed(0)}`, { parse_mode: "Markdown" });

  log(`${reason}: ${trade.symbol} · P&L: ₹${trade.exitPnL.toFixed(0)}`);

  // Daily loss cap check
  if (state.dayPnL.live <= -CONFIG.DAILY_LOSS_CAP && !state.isHalted) {
    state.isHalted = true;
    await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `🛑 *DAILY LOSS CAP HIT*\nLive loss: ₹${state.dayPnL.live.toFixed(0)}\nAll new trades blocked for today. Use /resume tomorrow.`, { parse_mode: "Markdown" });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 9. MAIN LOOP — scan watchlist every 60 seconds
// ═══════════════════════════════════════════════════════════════════════════
setInterval(async () => {
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  // Only during market hours (9:15 AM – 3:30 PM)
  if (mins < 555 || mins > 930) return;
  if (state.isHalted) return;

  for (const symbol of CONFIG.WATCHLIST) {
    const candles = state.candleBuffer.get(symbol);
    if (!candles || candles.length < 50) continue;

    // Skip if already in trade for this symbol
    if (state.openTrades.some(t => t.symbol === symbol && t.status === "open")) continue;

    const sig = analyzeSignal(symbol, candles);
    if (!sig || sig.signal === "HOLD") continue;
    if (!sig.safeToTrade) continue;

    // Always send to Telegram — user decides live vs paper vs skip
    await sendSignalAlert(sig);
  }
}, 60000);

// ═══════════════════════════════════════════════════════════════════════════
// 10. LOGGING & STARTUP
// ═══════════════════════════════════════════════════════════════════════════
function log(msg) {
  const ts = new Date().toISOString().replace("T", " ").substring(0, 19);
  console.log(`[${ts}] ${msg}`);
}

async function startup() {
  log("🚀 NSE TradeAI Bot v4 starting...");
  log(`   Capital:      ₹${CONFIG.CAPITAL.toLocaleString("en-IN")}`);
  log(`   Risk/trade:   ₹${CONFIG.RISK_PER_TRADE}`);
  log(`   Live trading: ${CONFIG.LIVE_TRADING ? "✅ ENABLED" : "❌ DISABLED (paper only)"}`);
  log(`   Watchlist:    ${CONFIG.WATCHLIST.length} stocks`);

  const authOk = await authenticateAngel();
  if (!authOk) { log("❌ Cannot start without Angel One auth"); process.exit(1); }

  // Resolve tokens for watchlist
  const tokens = [];
  for (const sym of CONFIG.WATCHLIST) {
    const t = await getSymbolToken(sym);
    if (t) tokens.push(t);
  }
  log(`✓ Resolved ${tokens.length} symbol tokens`);

  await startWebSocket(tokens);

  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, `🚀 *NSE TradeAI Bot Online*
━━━━━━━━━━━━━━━━
Capital: ₹2,50,000
Risk: ₹1,000/trade (will scale after 2 weeks)
Live: ${CONFIG.LIVE_TRADING ? "ON ⚡" : "OFF (paper only)"}
Watchlist: ${CONFIG.WATCHLIST.length} stocks

Commands:
/status · /positions · /stop · /resume`, { parse_mode: "Markdown" });

  log("✅ Bot fully operational");
}

startup().catch(e => { log(`💥 Fatal: ${e.message}`); process.exit(1); });

// Graceful shutdown
process.on("SIGINT", async () => {
  log("Shutting down...");
  await tg.sendMessage(ENV.TELEGRAM_CHAT_ID, "⚠️ Bot shutting down");
  if (state.ws) state.ws.close();
  process.exit(0);
});
