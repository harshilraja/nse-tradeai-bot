// ═══════════════════════════════════════════════════════════════════════════
// NSE TradeAI · Backtest API v7.0
//
// DESIGN:
//  • Imports analyzeSignal() directly from bot-server.js — zero divergence
//  • Fetches 5m + 15m + Daily for every symbol (same as live bot)
//  • Fetches Nifty + BankNifty daily trend per test window
//  • Simulates breakeven, partial booking, trailing SL exactly as live
//  • Broker charges (STT, GST, brokerage, stamp, DP) on every trade
//  • Detailed per-trade log with all indicator snapshots
//  • Rate-limited historical fetch (1100ms gap) to respect Angel limits
//  • REST endpoints: POST /run  GET /:id  GET /:id/trades  GET / (list)
// ═══════════════════════════════════════════════════════════════════════════

import axios from "axios";
import fs from "fs";

// ─── Import the EXACT same analyzeSignal and state from the live bot ───
// This guarantees backtest == live behaviour with zero code duplication
import { analyzeSignal, state as botState } from "./bot-server.js";

// ═══ CONSTANTS (must mirror bot-server CONFIG) ═══════════════════════════
const CFG = {
  RISK_PCT:              0.01,
  DAILY_LOSS_PCT:        0.02,
  SL_PCT:                0.012,
  TARGET_PCT:            0.030,
  ATR_SL_MULT:           2.5,
  ATR_TARGET_MULT:       6.0,
  BREAKEVEN_TRIGGER_PCT: 0.012,
  PARTIAL_BOOK_PCT:      0.020,
  PARTIAL_BOOK_FRACTION: 0.50,
  MIN_CANDLES:           30,
  MIN_SCORE_FOR_TRADE:   3.5,
  TRADING_START_MIN:     570,   // 9:30
  TRADING_END_MIN:       915,   // 3:15
  RATE_LIMIT_MS:         1100,  // 1 req/sec Angel limit
  CHARGES: {
    STT_PCT:        0.001,
    BROKERAGE_FLAT: 20,
    BROKERAGE_PCT:  0.0003,
    GST_PCT:        0.18,
    STAMP_PCT:      0.00015,
    EXCHANGE_PCT:   0.0000345,
    SEBI_PCT:       0.000001,
    DP_CHARGE:      15.93,
  },
  INDEX_TOKENS: {
    NIFTY:     "99926000",
    NIFTYBANK: "99926009",
  },
  NIFTY_50_FALLBACK: {
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
  },
};

// In-memory caches
const backtestCache  = new Map();  // id → result
const runningBacktests = new Map(); // id → progress
let scripMasterCache = null;

// ═══════════════════════════════════════════════════════════════════════════
// IST HELPERS
// ═══════════════════════════════════════════════════════════════════════════
function toIST(d) {
  return new Date(d.getTime() + d.getTimezoneOffset() * 60000 + 5.5 * 3600000);
}
function fmtAngelDate(d) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtIST(d) {
  if (!d) return "";
  const ist = toIST(typeof d === "string" ? new Date(d) : d);
  return ist.toLocaleString("en-IN", {
    day:"2-digit", month:"short", year:"numeric",
    hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:true
  });
}
function getRange(daysBack) {
  let end = toIST(new Date());
  if (end.getHours() < 9) end.setDate(end.getDate() - 1);
  while (end.getDay() === 0 || end.getDay() === 6) end.setDate(end.getDate() - 1);
  end.setHours(15, 30, 0, 0);
  let start = new Date(end);
  let count = 0;
  while (count < daysBack) {
    start.setDate(start.getDate() - 1);
    if (start.getDay() !== 0 && start.getDay() !== 6) count++;
  }
  start.setHours(9, 15, 0, 0);
  return { fromdate: fmtAngelDate(start), todate: fmtAngelDate(end) };
}

// ═══════════════════════════════════════════════════════════════════════════
// ANGEL HEADERS
// ═══════════════════════════════════════════════════════════════════════════
function hdrs() {
  return {
    "Authorization":    `Bearer ${botState.angelAuth}`,
    "Content-Type":     "application/json",
    "Accept":           "application/json",
    "X-UserType":       "USER",
    "X-SourceID":       "WEB",
    "X-ClientLocalIP":  "192.168.1.1",
    "X-ClientPublicIP": "103.0.0.1",
    "X-MACAddress":     "00:00:00:00:00:00",
    "X-PrivateKey":     process.env.ANGEL_API_KEY,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SCRIP MASTER (re-uses bot's in-memory master, falls back to disk/hardcoded)
// ═══════════════════════════════════════════════════════════════════════════
function getToken(symbol) {
  // Check bot state first
  if (botState.symbolTokens?.has(symbol)) return botState.symbolTokens.get(symbol);

  // Index tokens
  if (CFG.INDEX_TOKENS[symbol]) return CFG.INDEX_TOKENS[symbol];

  // Hardcoded fallback
  if (CFG.NIFTY_50_FALLBACK[symbol]) return CFG.NIFTY_50_FALLBACK[symbol];

  // Bot's scrip master
  const master = botState.scripMaster || scripMasterCache;
  if (!master) return null;
  const m = master.find(s => s.symbol === `${symbol}-EQ` && s.exch_seg === "NSE")
         || master.find(s => s.name === symbol && s.exch_seg === "NSE" && s.symbol?.endsWith("-EQ"));
  return m?.token || null;
}

// ═══════════════════════════════════════════════════════════════════════════
// HISTORICAL FETCH (rate-limited)
// ═══════════════════════════════════════════════════════════════════════════
async function fetchCandles(symbol, interval, days, retries = 2) {
  const token = getToken(symbol);
  if (!token) return [];

  const { fromdate, todate } = getRange(days);

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await axios.post(
        "https://apiconnect.angelbroking.com/rest/secure/angelbroking/historical/v1/getCandleData",
        { exchange: "NSE", symboltoken: token, interval, fromdate, todate },
        { headers: hdrs(), timeout: 20000 }
      );
      const raw = res.data?.data || [];
      return raw.map(c => ({
        time:   new Date(c[0]),
        bucket: c[0],
        o: parseFloat(c[1]),
        h: parseFloat(c[2]),
        l: parseFloat(c[3]),
        c: parseFloat(c[4]),
        v: parseInt(c[5]),
      }));
    } catch (e) {
      const status = e.response?.status;
      if (status === 401 && attempt < retries) { await delay(1000); continue; }
      if (status === 429 && attempt < retries) { await delay(3000); continue; }
      return [];
    }
  }
  return [];
}
const delay = ms => new Promise(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════════════
// INDEX TREND (Nifty / BankNifty) for test window
// ═══════════════════════════════════════════════════════════════════════════
function computeTrend(candles) {
  if (!candles || candles.length < 22) return "neutral";
  const closes = candles.map(c => c.c);
  const ema = (v, p) => {
    if (v.length < p) return v[v.length-1] || 0;
    const k = 2/(p+1);
    let e = v.slice(0,p).reduce((a,b)=>a+b,0)/p;
    for (let i=p; i<v.length; i++) e = v[i]*k + e*(1-k);
    return e;
  };
  const e9 = ema(closes, 9), e21 = ema(closes, 21);
  if (e9 > e21) return "bullish";
  if (e9 < e21) return "bearish";
  return "neutral";
}

// ═══════════════════════════════════════════════════════════════════════════
// CHARGE CALCULATOR (matches bot-server.js calculateCharges exactly)
// ═══════════════════════════════════════════════════════════════════════════
function calcCharges(buyValue, sellValue) {
  const C = CFG.CHARGES;
  const stt         = (buyValue + sellValue) * C.STT_PCT;
  const brokBuy     = Math.min(C.BROKERAGE_FLAT, buyValue  * C.BROKERAGE_PCT);
  const brokSell    = Math.min(C.BROKERAGE_FLAT, sellValue * C.BROKERAGE_PCT);
  const brokerage   = brokBuy + brokSell;
  const exchange    = (buyValue + sellValue) * C.EXCHANGE_PCT;
  const sebi        = (buyValue + sellValue) * C.SEBI_PCT;
  const gst         = (brokerage + exchange + sebi) * C.GST_PCT;
  const stamp       = buyValue * C.STAMP_PCT;
  const dp          = C.DP_CHARGE;
  const total       = stt + brokerage + exchange + sebi + gst + stamp + dp;
  return {
    stt:       +stt.toFixed(2),
    brokerage: +brokerage.toFixed(2),
    exchange:  +exchange.toFixed(2),
    sebi:      +sebi.toFixed(2),
    gst:       +gst.toFixed(2),
    stamp:     +stamp.toFixed(2),
    dp:        +dp.toFixed(2),
    total:     +total.toFixed(2),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SIMULATOR — exactly mirrors the trailing-SL engine in bot-server.js
// ═══════════════════════════════════════════════════════════════════════════
function simulateSymbol(symbol, c5, c15, cD, niftyTrend, bankNiftyTrend, capital) {
  const trades = [];
  let open = null;

  for (let i = CFG.MIN_CANDLES; i < c5.length; i++) {
    const candle = c5[i];
    const candleTime = candle.time instanceof Date ? candle.time : new Date(candle.time);
    const istTime = toIST(candleTime);
    const mins = istTime.getHours() * 60 + istTime.getMinutes();

    // Only within 9:30–3:15 window
    const inWindow = mins >= CFG.TRADING_START_MIN && mins <= CFG.TRADING_END_MIN;

    // ── Manage open trade ─────────────────────────────────────────────────
    if (open) {
      const t = open;

      if (t.signal === "BUY") {
        const profitPct = (candle.c - t.entry) / t.entry;

        // 1. Breakeven
        if (!t.breakevenTriggered && profitPct >= CFG.BREAKEVEN_TRIGGER_PCT) {
          t.currentSL = +(t.entry * 1.001).toFixed(2);
          t.breakevenTriggered = true;
          t.breakevenPrice = +candle.c.toFixed(2);
          t.breakevenTime  = fmtIST(candleTime);
        }

        // 2. Partial booking at +2%
        if (!t.partialBooked && profitPct >= CFG.PARTIAL_BOOK_PCT) {
          const pQty = Math.floor(t.originalQty * CFG.PARTIAL_BOOK_FRACTION);
          if (pQty > 0 && pQty < t.qty) {
            t.partialQty    = pQty;
            t.partialPrice  = +candle.c.toFixed(2);
            t.partialTime   = fmtIST(candleTime);
            t.partialGross  = +(( candle.c - t.entry) * pQty).toFixed(2);
            const pCharges  = calcCharges(t.entry * pQty, candle.c * pQty);
            t.partialNet    = +(t.partialGross - pCharges.total).toFixed(2);
            t.partialCharges = pCharges.total;
            t.qty          -= pQty;
            t.partialBooked = true;
          }
        }

        // 3. Trailing SL
        if (t.partialBooked) {
          const gain   = candle.c - t.entry;
          const newSL  = +(t.entry + gain * 0.8).toFixed(2);
          if (newSL > t.currentSL) t.currentSL = newSL;
        } else if (t.breakevenTriggered) {
          const gain   = candle.c - t.entry;
          const newSL  = +(t.entry + gain * 0.5).toFixed(2);
          if (newSL > t.currentSL) t.currentSL = newSL;
        }

        // 4. Check exits
        if (candle.l <= t.currentSL) {
          open = closeTrade(t, t.currentSL, "SL", candleTime, trades);
          continue;
        }
        if (candle.h >= t.target) {
          open = closeTrade(t, t.target, "TARGET", candleTime, trades);
          continue;
        }
      }

      // SELL mirror logic
      if (t.signal === "SELL") {
        const profitPct = (t.entry - candle.c) / t.entry;
        if (!t.breakevenTriggered && profitPct >= CFG.BREAKEVEN_TRIGGER_PCT) {
          t.currentSL = +(t.entry * 0.999).toFixed(2);
          t.breakevenTriggered = true;
        }
        if (!t.partialBooked && profitPct >= CFG.PARTIAL_BOOK_PCT) {
          const pQty = Math.floor(t.originalQty * CFG.PARTIAL_BOOK_FRACTION);
          if (pQty > 0 && pQty < t.qty) {
            t.partialGross  = +((t.entry - candle.c) * pQty).toFixed(2);
            const pCharges  = calcCharges(t.entry * pQty, candle.c * pQty);
            t.partialNet    = +(t.partialGross - pCharges.total).toFixed(2);
            t.qty          -= pQty;
            t.partialBooked = true;
          }
        }
        if (candle.h >= t.currentSL) {
          open = closeTrade(t, t.currentSL, "SL", candleTime, trades);
          continue;
        }
        if (candle.l <= t.target) {
          open = closeTrade(t, t.target, "TARGET", candleTime, trades);
          continue;
        }
      }
    }

    // ── New signal ────────────────────────────────────────────────────────
    if (!open && inWindow) {
      const c5Slice  = c5.slice(Math.max(0, i - 300), i + 1);
      const c15Slice = c15.filter(c => new Date(c.time) <= candleTime).slice(-200);
      const cDSlice  = cD.filter(c  => new Date(c.time) <= candleTime).slice(-100);

      // Override botState.capital for sizing
      const savedCap = botState.capital;
      botState.capital = capital;

      const sig = analyzeSignal(
        symbol, c5Slice, c15Slice, cDSlice,
        niftyTrend, bankNiftyTrend,
        false
      );

      botState.capital = savedCap;

      if (!sig || sig.rejected || sig.signal === "HOLD" || !sig.safeToTrade) continue;
      if (Math.abs(sig.score) < CFG.MIN_SCORE_FOR_TRADE) continue;

      const stopDist   = Math.max(sig.entry * CFG.SL_PCT, sig.indicators.atr * CFG.ATR_SL_MULT);
      const targetDist = Math.max(sig.entry * CFG.TARGET_PCT, sig.indicators.atr * CFG.ATR_TARGET_MULT);
      const riskAmt    = capital * CFG.RISK_PCT;
      const qty        = Math.max(1, Math.floor(riskAmt / stopDist));

      open = {
        // Identification
        symbol,
        signal:   sig.signal,
        // Entry
        entry:    sig.entry,
        entryTime:          candleTime.toISOString(),
        entryTimeIST:       fmtIST(candleTime),
        // Position
        qty,
        originalQty:        qty,
        // Levels
        sl:         sig.signal === "BUY" ? +(sig.entry - stopDist).toFixed(2) : +(sig.entry + stopDist).toFixed(2),
        currentSL:  sig.signal === "BUY" ? +(sig.entry - stopDist).toFixed(2) : +(sig.entry + stopDist).toFixed(2),
        target:     sig.signal === "BUY" ? +(sig.entry + targetDist).toFixed(2) : +(sig.entry - targetDist).toFixed(2),
        // Flags
        breakevenTriggered: false,
        breakevenPrice:     null,
        breakevenTime:      null,
        partialBooked:      false,
        partialQty:         0,
        partialPrice:       null,
        partialTime:        null,
        partialGross:       0,
        partialNet:         0,
        partialCharges:     0,
        // Signal metadata (REQ 8)
        confidence:    sig.confidence,
        score:         sig.score,
        rsi:           sig.indicators.rsi,
        adx:           sig.indicators.adx,
        vwap:          sig.indicators.vwap,
        supertrend:    sig.indicators.supertrend,
        atr:           sig.indicators.atr,
        volRatio:      sig.indicators.volRatio,
        pattern:       sig.indicators.pattern,
        macd:          sig.indicators.checks.macd || "—",
        ema:           sig.indicators.checks.ema  || "—",
        bb:            sig.indicators.checks.bb   || "—",
        trend15m:      sig.indicators.trend15m,
        trendDaily:    sig.indicators.trendDaily,
        indexTrend:    sig.indicators.indexTrend,
        bullCount:     sig.bullCount,
        bearCount:     sig.bearCount,
        filtersPassed: sig.filtersPassed,
      };
    }
  }

  // End of data — close remaining
  if (open) {
    const last = c5[c5.length - 1];
    open = closeTrade(open, last.c, "END_OF_DATA", last.time, trades);
  }

  return trades;
}

// ── Close helper ────────────────────────────────────────────────────────────
function closeTrade(t, exitPrice, exitReason, exitTime, trades) {
  t.exit        = +exitPrice.toFixed(2);
  t.exitTime    = exitTime instanceof Date ? exitTime.toISOString() : exitTime;
  t.exitTimeIST = fmtIST(exitTime);
  t.exitReason  = exitReason;

  const dir = t.signal === "BUY" ? 1 : -1;
  t.grossPnL    = +((t.exit - t.entry) * t.qty * dir).toFixed(2);

  // Add partial PnL
  const totalGross = t.grossPnL + (t.partialGross || 0);

  // Charges on remaining qty exit
  const buyVal  = t.entry * t.originalQty;
  const sellVal = t.exit  * t.qty + (t.partialPrice || 0) * (t.partialQty || 0);
  t.charges     = calcCharges(buyVal, sellVal);
  t.netPnL      = +(totalGross - t.charges.total).toFixed(2);
  t.totalGross  = +totalGross.toFixed(2);

  // Capital & risk
  t.capital      = +(t.entry * t.originalQty).toFixed(2);
  t.maxLoss      = +Math.abs(t.entry - t.sl).toFixed(2) * t.originalQty;
  t.maxGain      = +Math.abs(t.target - t.entry).toFixed(2) * t.originalQty;

  trades.push(t);
  return null;  // Clear open
}

// ═══════════════════════════════════════════════════════════════════════════
// METRICS CALCULATOR
// ═══════════════════════════════════════════════════════════════════════════
function calcMetrics(allTrades, capital) {
  const n = allTrades.length;
  if (n === 0) return { total: 0, verdict: "NO_TRADES", verdictColor: "orange" };

  const wins   = allTrades.filter(t => t.netPnL > 0);
  const losses = allTrades.filter(t => t.netPnL <= 0);

  const totalNet    = allTrades.reduce((s, t) => s + t.netPnL,    0);
  const totalGross  = allTrades.reduce((s, t) => s + t.totalGross,0);
  const totalCharges= allTrades.reduce((s, t) => s + t.charges.total, 0);

  const grossWin  = wins.reduce((s, t)   => s + t.netPnL, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnL, 0));
  const pf        = grossLoss > 0 ? grossWin / grossLoss : grossWin;

  // Equity curve + drawdown
  let peak = 0, maxDD = 0, running = 0;
  const equityCurve = [];
  const dailyPnL    = {};
  for (const t of allTrades) {
    running += t.netPnL;
    equityCurve.push({ time: t.exitTime, pnl: running, trade: t.symbol });
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > maxDD) maxDD = dd;
    const day = t.exitTime?.slice(0, 10);
    if (day) dailyPnL[day] = +(((dailyPnL[day] || 0) + t.netPnL).toFixed(2));
  }

  // Max consecutive losses
  let maxConsec = 0, curConsec = 0;
  for (const t of allTrades) {
    if (t.netPnL < 0) { curConsec++; maxConsec = Math.max(maxConsec, curConsec); }
    else curConsec = 0;
  }

  // Per-symbol
  const bySymbol = {};
  for (const t of allTrades) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { trades:0, wins:0, grossPnL:0, netPnL:0, totalCharges:0 };
    bySymbol[t.symbol].trades++;
    if (t.netPnL > 0) bySymbol[t.symbol].wins++;
    bySymbol[t.symbol].grossPnL   = +(bySymbol[t.symbol].grossPnL   + t.totalGross).toFixed(2);
    bySymbol[t.symbol].netPnL     = +(bySymbol[t.symbol].netPnL     + t.netPnL).toFixed(2);
    bySymbol[t.symbol].totalCharges = +(bySymbol[t.symbol].totalCharges + t.charges.total).toFixed(2);
  }
  for (const s in bySymbol) {
    bySymbol[s].winRate = +((bySymbol[s].wins / bySymbol[s].trades) * 100).toFixed(1);
  }

  // By exit reason
  const byReason = { TARGET:0, SL:0, END_OF_DATA:0 };
  for (const t of allTrades) byReason[t.exitReason] = (byReason[t.exitReason] || 0) + 1;

  // Charge totals aggregated
  const aggregatedCharges = {
    stt:        +allTrades.reduce((s,t) => s + t.charges.stt, 0).toFixed(2),
    brokerage:  +allTrades.reduce((s,t) => s + t.charges.brokerage, 0).toFixed(2),
    gst:        +allTrades.reduce((s,t) => s + t.charges.gst, 0).toFixed(2),
    exchange:   +allTrades.reduce((s,t) => s + t.charges.exchange, 0).toFixed(2),
    sebi:       +allTrades.reduce((s,t) => s + t.charges.sebi, 0).toFixed(2),
    stamp:      +allTrades.reduce((s,t) => s + t.charges.stamp, 0).toFixed(2),
    dp:         +allTrades.reduce((s,t) => s + t.charges.dp, 0).toFixed(2),
    total:      +totalCharges.toFixed(2),
  };

  const winRate   = +((wins.length / n) * 100).toFixed(2);
  const returnPct = +((totalNet / capital) * 100).toFixed(2);

  // Verdict (1:4 RR adjusted thresholds)
  let verdict = "POOR", verdictColor = "red";
  const wr = winRate, pff = +pf.toFixed(2);
  if (totalNet > 0 && wr >= 50 && pff >= 2.0) { verdict = "EXCELLENT"; verdictColor = "green"; }
  else if (totalNet > 0 && wr >= 35 && pff >= 1.5) { verdict = "GOOD";  verdictColor = "green"; }
  else if (totalNet > 0 && pff >= 1.2)              { verdict = "MARGINAL"; verdictColor = "orange"; }
  else if (totalNet > 0)                             { verdict = "BREAK_EVEN"; verdictColor = "orange"; }

  return {
    total: n,
    wins:  wins.length,
    losses: losses.length,
    winRate,
    totalGross:    +totalGross.toFixed(2),
    totalCharges:  +totalCharges.toFixed(2),
    totalNet:      +totalNet.toFixed(2),
    returnPct,
    profitFactor:  +pf.toFixed(2),
    avgWin:        +(wins.length   ? grossWin  / wins.length  : 0).toFixed(2),
    avgLoss:       +(losses.length ? -grossLoss / losses.length : 0).toFixed(2),
    best:          +Math.max(...allTrades.map(t => t.netPnL)).toFixed(2),
    worst:         +Math.min(...allTrades.map(t => t.netPnL)).toFixed(2),
    maxDrawdown:   +maxDD.toFixed(2),
    maxConsecLosses: maxConsec,
    aggregatedCharges,
    bySymbol,
    byReason,
    dailyPnL,
    equityCurve: equityCurve.slice(-200),
    verdict,
    verdictColor,
    strategyVersion: "v7.0",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// RUNNER  (async, stores result in cache)
// ═══════════════════════════════════════════════════════════════════════════
async function runBacktestJob(id, symbols, days, capital) {
  runningBacktests.set(id, { done:0, total:symbols.length, currentSymbol:"", startedAt: new Date().toISOString() });
  const log = m => console.log(`[BT ${id}] ${m}`);

  // Fetch index trends once for the entire window
  log("Fetching Nifty / BankNifty trends...");
  const niftyDaily     = await fetchCandles("NIFTY",     "ONE_DAY", days);
  await delay(CFG.RATE_LIMIT_MS);
  const bankNiftyDaily = await fetchCandles("NIFTYBANK",  "ONE_DAY", days);
  await delay(CFG.RATE_LIMIT_MS);

  const niftyTrend     = computeTrend(niftyDaily);
  const bankNiftyTrend = computeTrend(bankNiftyDaily);
  log(`Index trends: Nifty=${niftyTrend}, BankNifty=${bankNiftyTrend}`);

  const allTrades  = [];
  const perSymbol  = {};
  const errors     = [];

  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    runningBacktests.set(id, { done:i, total:symbols.length, currentSymbol:sym, startedAt: new Date().toISOString() });

    log(`[${i+1}/${symbols.length}] ${sym}`);

    // Fetch 5m
    const c5 = await fetchCandles(sym, "FIVE_MINUTE",    days);
    await delay(CFG.RATE_LIMIT_MS);
    // Fetch 15m
    const c15 = await fetchCandles(sym, "FIFTEEN_MINUTE", days);
    await delay(CFG.RATE_LIMIT_MS);
    // Fetch Daily
    const cD  = await fetchCandles(sym, "ONE_DAY",        days);
    await delay(CFG.RATE_LIMIT_MS);

    if (!c5.length) {
      errors.push(sym);
      perSymbol[sym] = { error:"no data", trades:0 };
      continue;
    }

    const trades = simulateSymbol(sym, c5, c15, cD, niftyTrend, bankNiftyTrend, capital);
    allTrades.push(...trades);
    perSymbol[sym] = {
      candles5m:  c5.length,
      candles15m: c15.length,
      candlesDaily: cD.length,
      trades:  trades.length,
      wins:    trades.filter(t => t.netPnL > 0).length,
      grossPnL: +trades.reduce((s,t) => s + t.totalGross, 0).toFixed(2),
      netPnL:   +trades.reduce((s,t) => s + t.netPnL,    0).toFixed(2),
    };
    log(`  ${trades.length} trades · net ₹${perSymbol[sym].netPnL}`);
  }

  const metrics = calcMetrics(allTrades, capital);

  // Build detailed trade log (REQ 8) — all fields
  const detailedTrades = allTrades.map(t => ({
    // Date & Time (IST)
    dateIST:        t.entryTimeIST,
    exitDateIST:    t.exitTimeIST,
    // Core
    symbol:         t.symbol,
    signal:         t.signal,
    entryPrice:     t.entry,
    entryTime:      t.entryTime,
    exitPrice:      t.exit,
    exitTime:       t.exitTime,
    quantity:       t.originalQty,
    sl:             t.sl,
    target:         t.target,
    exitReason:     t.exitReason,
    // P&L
    grossPnL:       t.totalGross,
    netPnL:         t.netPnL,
    charges:        t.charges.total,
    chargesBreakdown: t.charges,
    // Partial
    partialBooked:  t.partialBooked,
    partialQty:     t.partialQty || 0,
    partialPrice:   t.partialPrice || null,
    partialGross:   t.partialGross || 0,
    partialNet:     t.partialNet   || 0,
    // Breakeven
    breakevenTriggered: t.breakevenTriggered,
    breakevenPrice:     t.breakevenPrice || null,
    // Signal metadata (REQ 8 indicators snapshot)
    confidence:  t.confidence,
    score:       t.score,
    rsi:         t.rsi,
    adx:         t.adx,
    vwap:        t.vwap,
    supertrend:  t.supertrend,
    atr:         t.atr,
    volRatio:    t.volRatio,
    pattern:     t.pattern,
    macd:        t.macd,
    ema:         t.ema,
    bb:          t.bb,
    trend15m:    t.trend15m,
    trendDaily:  t.trendDaily,
    indexTrend:  t.indexTrend,
    bullCount:   t.bullCount,
    bearCount:   t.bearCount,
    // Risk info
    capital:  t.capital,
    maxLoss:  t.maxLoss,
    maxGain:  t.maxGain,
  }));

  const result = {
    backtestId: id,
    runDate:    new Date().toISOString(),
    config: {
      days, symbols, capital,
      niftyTrend, bankNiftyTrend,
      strategy: "v7.0",
      tradingWindow: "9:30–15:15",
      orderType: "DELIVERY",
    },
    metrics,
    perSymbol,
    errors,
    trades: detailedTrades,
  };

  backtestCache.set(id, result);
  runningBacktests.delete(id);

  // Persist to disk
  try {
    if (!fs.existsSync("./backtests")) fs.mkdirSync("./backtests");
    fs.writeFileSync(`./backtests/${id}.json`, JSON.stringify(result, null, 2));
  } catch {}

  log(`DONE · ${metrics.total} trades · ${metrics.winRate}% win · ₹${metrics.totalNet} net`);
}

// ═══════════════════════════════════════════════════════════════════════════
// REST ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════
export function addBacktestEndpoints(app, auth) {

  // ── POST /api/backtest/run ──────────────────────────────────────────────
  app.post("/api/backtest/run", auth, async (req, res) => {
    const {
      days    = 30,
      symbols,
      capital = botState.capital || 250000,
    } = req.body;

    // Default: Nifty 50 first 25 for quick runs; full 70 for extended
    const defaultSymbols = [
      "RELIANCE","HDFCBANK","ICICIBANK","INFY","TCS","HINDUNILVR","ITC","BHARTIARTL",
      "SBIN","LT","KOTAKBANK","AXISBANK","BAJFINANCE","ASIANPAINT","MARUTI",
      "SUNPHARMA","TITAN","HCLTECH","NTPC","WIPRO","POWERGRID","TATASTEEL",
      "TECHM","JSWSTEEL","ADANIENT",
    ];
    const symList = Array.isArray(symbols) && symbols.length ? symbols : defaultSymbols;

    const id = `bt-${Date.now()}`;
    res.json({
      backtestId: id,
      status:     "running",
      symbols:    symList.length,
      days,
      capital,
      estimatedTime: `${Math.ceil(symList.length * 3.3 / 60)}m`,
    });

    // Run in background (don't await)
    runBacktestJob(id, symList, days, capital).catch(e =>
      console.error(`[BT ${id}] Fatal: ${e.message}`)
    );
  });

  // ── GET /api/backtest/:id ───────────────────────────────────────────────
  app.get("/api/backtest/:id", auth, (req, res) => {
    const result  = backtestCache.get(req.params.id);
    const running = runningBacktests.get(req.params.id);

    if (result)  return res.json({ status:"completed", ...result });
    if (running) return res.json({ status:"running",   progress: running });

    // Try disk
    const path = `./backtests/${req.params.id}.json`;
    if (fs.existsSync(path)) {
      try {
        const r = JSON.parse(fs.readFileSync(path, "utf8"));
        backtestCache.set(req.params.id, r);
        return res.json({ status:"completed", ...r });
      } catch {}
    }

    res.status(404).json({ error: "Backtest not found" });
  });

  // ── GET /api/backtest/:id/trades ────────────────────────────────────────
  app.get("/api/backtest/:id/trades", auth, (req, res) => {
    const result = backtestCache.get(req.params.id);
    if (!result) return res.status(404).json({ error: "Not found" });

    const { page = 1, limit = 50, symbol, exitReason, signal } = req.query;
    let trades = result.trades;

    if (symbol)     trades = trades.filter(t => t.symbol === symbol);
    if (exitReason) trades = trades.filter(t => t.exitReason === exitReason);
    if (signal)     trades = trades.filter(t => t.signal === signal);

    const total = trades.length;
    const start = (parseInt(page) - 1) * parseInt(limit);
    const end   = start + parseInt(limit);

    res.json({
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      pages: Math.ceil(total / parseInt(limit)),
      trades: trades.slice(start, end),
    });
  });

  // ── GET /api/backtest ────────────────────────────────────────────────────
  app.get("/api/backtest", auth, (req, res) => {
    // Also scan disk for persisted runs
    try {
      if (fs.existsSync("./backtests")) {
        const files = fs.readdirSync("./backtests").filter(f => f.endsWith(".json"));
        for (const f of files) {
          const id = f.replace(".json", "");
          if (!backtestCache.has(id)) {
            try {
              const r = JSON.parse(fs.readFileSync(`./backtests/${f}`, "utf8"));
              backtestCache.set(id, r);
            } catch {}
          }
        }
      }
    } catch {}

    const list = [...backtestCache.entries()]
      .map(([id, r]) => ({
        id,
        runDate:     r.runDate,
        days:        r.config?.days,
        symbols:     r.config?.symbols?.length,
        capital:     r.config?.capital,
        totalTrades: r.metrics?.total,
        totalNet:    r.metrics?.totalNet,
        totalGross:  r.metrics?.totalGross,
        totalCharges:r.metrics?.totalCharges,
        winRate:     r.metrics?.winRate,
        profitFactor:r.metrics?.profitFactor,
        verdict:     r.metrics?.verdict,
        verdictColor:r.metrics?.verdictColor,
        returnPct:   r.metrics?.returnPct,
        niftyTrend:  r.config?.niftyTrend,
        bankNiftyTrend: r.config?.bankNiftyTrend,
      }))
      .sort((a, b) => new Date(b.runDate) - new Date(a.runDate));

    res.json(list.slice(0, 30));
  });

  // ── DELETE /api/backtest/:id ─────────────────────────────────────────────
  app.delete("/api/backtest/:id", auth, (req, res) => {
    backtestCache.delete(req.params.id);
    try { fs.unlinkSync(`./backtests/${req.params.id}.json`); } catch {}
    res.json({ ok: true });
  });
}
