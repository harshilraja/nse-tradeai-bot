// ═══════════════════════════════════════════════════════════════════════════
// NSE TradeAI · Backtest API v6.3
// MATCHES live bot strategy: ATR-SL · ADX filter · EMA200 · Supertrend · Patterns
// Replace your existing backtest-api.js with this file
// ═══════════════════════════════════════════════════════════════════════════

import axios from "axios";
import fs from "fs";

const backtestCache = new Map();
const runningBacktests = new Map();

// ═══ CONFIG (must match live bot v6.3) ═════════════════════════════════════
const STRATEGY = {
  // Risk-reward
  SL_PCT:            0.006,
  TARGET_PCT:        0.024,
  REWARD_RATIO:      4,

  // Signal thresholds
  SIGNAL_SCORE_BUY:  4.0,
  SIGNAL_SCORE_SELL: -4.0,
  MIN_CONFLUENCE:    4,
  MIN_CONFIDENCE:    65,
  MIN_VOLUME_RATIO:  1.3,
  MIN_CANDLES:       30,
  MIN_ADX:           25,

  // Position sizing
  RISK_PER_TRADE:    1000,
  ATR_SL_MULTIPLIER: 1.5,
  ATR_TARGET_MULTIPLIER: 4.5,
};

// ═══ ANGEL HEADERS ═════════════════════════════════════════════════════════
function angelHeaders(state) {
  return {
    "Authorization":    `Bearer ${state.angelAuth}`,
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

// ═══ DATE HELPERS ══════════════════════════════════════════════════════════
function getIST() {
  const now = new Date();
  return new Date(now.getTime() + (now.getTimezoneOffset() * 60 * 1000) + (5.5 * 60 * 60 * 1000));
}

function formatDate(d) {
  const pad = n => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function getHistoricalRange(daysBack) {
  let end = getIST();
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
  return { from: formatDate(start), to: formatDate(end) };
}

// ═══ FETCH HISTORICAL ══════════════════════════════════════════════════════
async function fetchHistorical(symbol, days, state) {
  const scripMaster = state.scripMaster;
  if (!scripMaster) return null;
  const match = scripMaster.find(s => s.symbol === `${symbol}-EQ` && s.exch_seg === "NSE");
  if (!match?.token) return null;

  const { from, to } = getHistoricalRange(days);
  try {
    const res = await axios.post(
      "https://apiconnect.angelbroking.com/rest/secure/angelbroking/historical/v1/getCandleData",
      {
        exchange: "NSE", symboltoken: match.token,
        interval: "FIVE_MINUTE", fromdate: from, todate: to,
      },
      { headers: angelHeaders(state), timeout: 30000 }
    );
    const data = res.data?.data || [];
    return data.map(c => ({
      time: new Date(c[0]),
      o: parseFloat(c[1]), h: parseFloat(c[2]),
      l: parseFloat(c[3]), c: parseFloat(c[4]),
      v: parseInt(c[5]),
    }));
  } catch (e) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ALL 7 INDICATORS (matching live bot v6.3)
// ═══════════════════════════════════════════════════════════════════════════
const ema = (v, p) => {
  if (v.length < p) return v[v.length-1] || 0;
  const k = 2/(p+1);
  let e = v.slice(0,p).reduce((a,b) => a+b, 0)/p;
  for (let i=p; i<v.length; i++) e = v[i]*k + e*(1-k);
  return e;
};

const sma = (v, p) => v.length < p ? (v[v.length-1] || 0) : v.slice(-p).reduce((a,b) => a+b, 0) / p;

function rsi(c, p=14) {
  if (c.length < p+1) return 50;
  const ch = c.slice(1).map((x,i) => x-c[i]);
  const g = ch.map(x => x>0?x:0);
  const l = ch.map(x => x<0?-x:0);
  let ag = g.slice(0,p).reduce((a,b) => a+b, 0)/p;
  let al = l.slice(0,p).reduce((a,b) => a+b, 0)/p;
  for (let i=p; i<ch.length; i++) {
    ag = (ag*(p-1)+g[i])/p;
    al = (al*(p-1)+l[i])/p;
  }
  return 100 - 100/(1 + ag/(al||0.001));
}

function macd(c) {
  const e12 = ema(c, 12);
  const e26 = ema(c, 26);
  return { value: e12 - e26, bullish: e12 > e26 };
}

function vwap(cs) {
  if (!cs.length) return 0;
  let pv = 0, tv = 0;
  for (const c of cs) {
    pv += ((c.h + c.l + c.c) / 3) * c.v;
    tv += c.v;
  }
  return tv > 0 ? pv / tv : cs[cs.length - 1].c;
}

function atr(cs, p = 14) {
  if (cs.length < p + 1) return 0;
  const trs = [];
  for (let i = 1; i < cs.length; i++) {
    const h = cs[i].h, l = cs[i].l, pc = cs[i-1].c;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return sma(trs.slice(-p), p);
}

function adx(cs, p = 14) {
  if (cs.length < p * 2) return { adx: 0, plusDI: 0, minusDI: 0, trending: false };
  const pdms = [], mdms = [], trs = [];
  for (let i = 1; i < cs.length; i++) {
    const um = cs[i].h - cs[i-1].h;
    const dm = cs[i-1].l - cs[i].l;
    pdms.push(um > dm && um > 0 ? um : 0);
    mdms.push(dm > um && dm > 0 ? dm : 0);
    const h = cs[i].h, l = cs[i].l, pc = cs[i-1].c;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const stt = sma(trs.slice(-p), p);
  const spm = sma(pdms.slice(-p), p);
  const smm = sma(mdms.slice(-p), p);
  const pdi = (spm / (stt || 1)) * 100;
  const mdi = (smm / (stt || 1)) * 100;
  const dx = Math.abs(pdi - mdi) / ((pdi + mdi) || 1) * 100;
  return { adx: dx, plusDI: pdi, minusDI: mdi, trending: dx > 25 };
}

function supertrend(cs, p = 10, m = 3) {
  if (cs.length < p) return { trend: "neutral" };
  const a = atr(cs, p);
  const last = cs[cs.length - 1];
  const hl2 = (last.h + last.l) / 2;
  const ub = hl2 + m * a;
  const lb = hl2 - m * a;
  return { trend: last.c > ub ? "bull" : last.c < lb ? "bear" : "neutral" };
}

function bollinger(c, p = 20) {
  if (c.length < p) return { upper: 0, lower: 0, mid: 0 };
  const s = c.slice(-p);
  const m = s.reduce((a, b) => a + b, 0) / p;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - m) ** 2, 0) / p);
  return { upper: m + 2 * sd, mid: m, lower: m - 2 * sd };
}

// ═══════════════════════════════════════════════════════════════════════════
// STRATEGY ENGINE — IDENTICAL to live bot v6.3
// ═══════════════════════════════════════════════════════════════════════════
function analyzeAt(candles, i, relaxed = false) {
  const win = candles.slice(Math.max(0, i - 200), i + 1);
  if (win.length < STRATEGY.MIN_CANDLES) return null;

  const closes = win.map(c => c.c);
  const vols = win.map(c => c.v);
  const price = closes[closes.length - 1];

  // ═══ Indicators ═══
  const R = rsi(closes);
  const M = macd(closes);
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const e200 = ema(closes, Math.min(200, closes.length - 1));
  const vw = vwap(win);
  const adxData = adx(win);
  const st = supertrend(win);
  const bb = bollinger(closes);
  const a = atr(win);
  const avgVol = vols.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, vols.length);
  const volRatio = avgVol > 0 ? vols[vols.length - 1] / avgVol : 1;

  // ═══ ADX trend filter (rejects sideways markets) ═══
  if (!relaxed && adxData.adx < STRATEGY.MIN_ADX) {
    return null;
  }

  // ═══ Long-term trend ═══
  const longTermBullish = price > e200;
  const longTermBearish = price < e200;

  // ═══ Candlestick patterns ═══
  const last = win[win.length - 1];
  const prev = win[win.length - 2];

  const isBullishEngulfing = prev && last.c > last.o && prev.c < prev.o &&
                             last.c > prev.o && last.o < prev.c;
  const isHammer = last && (last.c - last.l) > 2 * (last.h - last.c) &&
                   last.c > last.o;
  const isBearishEngulfing = prev && last.c < last.o && prev.c > prev.o &&
                             last.c < prev.o && last.o > prev.c;
  const isShootingStar = last && (last.h - last.c) > 2 * (last.c - last.l) &&
                         last.c < last.o;

  // ═══ Scoring ═══
  let score = 0;
  let bullCount = 0, bearCount = 0;

  // RSI (weight: 2.5)
  if (R < 30) { score += 2.5; bullCount++; }
  else if (R > 70) { score -= 2.5; bearCount++; }
  else if (R < 40 && longTermBullish) { score += 1; bullCount++; }
  else if (R > 60 && longTermBearish) { score -= 1; bearCount++; }

  // MACD (weight: 2)
  if (M.bullish && M.value > 0) { score += 2; bullCount++; }
  else if (!M.bullish && M.value < 0) { score -= 2; bearCount++; }
  else if (M.bullish) score += 0.5;
  else score -= 0.5;

  // EMA alignment (weight: 2.5)
  if (e9 > e21 && e21 > e50 && e50 > e200) { score += 2.5; bullCount++; }
  else if (e9 < e21 && e21 < e50 && e50 < e200) { score -= 2.5; bearCount++; }
  else if (e9 > e21 && e21 > e50) { score += 1; bullCount++; }
  else if (e9 < e21 && e21 < e50) { score -= 1; bearCount++; }

  // VWAP (weight: 2)
  if (price > vw * 1.003) { score += 2; bullCount++; }
  else if (price < vw * 0.997) { score -= 2; bearCount++; }

  // ADX (weight: 1.5)
  if (adxData.trending && adxData.adx > 30) {
    if (adxData.plusDI > adxData.minusDI * 1.2) { score += 1.5; bullCount++; }
    else if (adxData.minusDI > adxData.plusDI * 1.2) { score -= 1.5; bearCount++; }
  } else if (adxData.trending) {
    if (adxData.plusDI > adxData.minusDI) score += 0.5;
    else score -= 0.5;
  }

  // Supertrend (weight: 1.5)
  if (st.trend === "bull") { score += 1.5; bullCount++; }
  else if (st.trend === "bear") { score -= 1.5; bearCount++; }

  // Bollinger + RSI confluence (weight: 1.5)
  if (price <= bb.lower * 1.005 && R < 35) score += 1.5;
  else if (price >= bb.upper * 0.995 && R > 65) score -= 1.5;

  // Candlestick patterns (weight: 1.5)
  if (isBullishEngulfing || isHammer) { score += 1.5; bullCount++; }
  else if (isBearishEngulfing || isShootingStar) { score -= 1.5; bearCount++; }

  // Volume multiplier
  if (volRatio > 2.0) score *= 1.2;
  else if (volRatio > 1.5) score *= 1.1;
  else if (volRatio < 0.7) score *= 0.7;

  // Long-term trend override
  if (longTermBearish && score > 0) score *= 0.5;
  if (longTermBullish && score < 0) score *= 0.5;

  // ═══ Determine signal ═══
  const sb = relaxed ? 2.5 : STRATEGY.SIGNAL_SCORE_BUY;
  const ss = relaxed ? -2.5 : STRATEGY.SIGNAL_SCORE_SELL;
  const mc = relaxed ? 3 : STRATEGY.MIN_CONFLUENCE;
  const minVol = relaxed ? 1.0 : STRATEGY.MIN_VOLUME_RATIO;
  const minConfPct = relaxed ? 60 : STRATEGY.MIN_CONFIDENCE;

  let signal = "HOLD", confidence = 50;
  if (score >= sb) {
    signal = "BUY";
    confidence = Math.min(55 + score * 3, 85);
  } else if (score <= ss) {
    signal = "SELL";
    confidence = Math.min(55 + Math.abs(score) * 3, 82);
  }

  const maxConf = Math.max(bullCount, bearCount);

  // Apply ALL filters (matching live bot)
  const safeToTrade = maxConf >= mc &&
                      volRatio >= minVol &&
                      Math.abs(score) >= Math.abs(sb) &&
                      confidence >= minConfPct &&
                      (signal === "BUY" ? !longTermBearish : signal === "SELL" ? !longTermBullish : true);

  return {
    signal, score, confidence, safeToTrade, price,
    atrValue: a,  // For ATR-based SL
    indicators: { rsi: R, adx: adxData.adx, vwap: vw, supertrend: st.trend },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SIMULATOR with ATR-based SL/Target (matching live bot)
// ═══════════════════════════════════════════════════════════════════════════
function simulate(symbol, candles, config) {
  const trades = [];
  let open = null;

  for (let i = STRATEGY.MIN_CANDLES; i < candles.length; i++) {
    const c = candles[i];
    const mins = c.time.getHours() * 60 + c.time.getMinutes();
    const inMarket = mins >= 570 && mins <= 900;

    // EOD square-off
    if (!inMarket && open && mins >= 915) {
      open.exit = c.c;
      open.exitTime = c.time;
      open.exitReason = "EOD";
      open.pnl = (open.exit - open.entry) * open.qty * (open.signal === "BUY" ? 1 : -1);
      trades.push(open);
      open = null;
      continue;
    }
    if (!inMarket) continue;

    // Check open trade
    if (open) {
      const t = open;
      if (t.signal === "BUY") {
        const gain = c.c - t.entry;
        if (gain > 0) {
          const newSL = t.initialSL + gain;
          if (newSL > t.currentSL) t.currentSL = newSL;
        }
        if (c.l <= t.currentSL) {
          t.exit = t.currentSL;
          t.exitTime = c.time;
          t.exitReason = "SL";
          t.pnl = (t.exit - t.entry) * t.qty;
          trades.push(t);
          open = null;
          continue;
        }
        if (c.h >= t.target) {
          t.exit = t.target;
          t.exitTime = c.time;
          t.exitReason = "TARGET";
          t.pnl = (t.exit - t.entry) * t.qty;
          trades.push(t);
          open = null;
          continue;
        }
      } else {
        const gain = t.entry - c.c;
        if (gain > 0) {
          const newSL = t.initialSL - gain;
          if (newSL < t.currentSL) t.currentSL = newSL;
        }
        if (c.h >= t.currentSL) {
          t.exit = t.currentSL;
          t.exitTime = c.time;
          t.exitReason = "SL";
          t.pnl = (t.entry - t.exit) * t.qty;
          trades.push(t);
          open = null;
          continue;
        }
        if (c.l <= t.target) {
          t.exit = t.target;
          t.exitTime = c.time;
          t.exitReason = "TARGET";
          t.pnl = (t.entry - t.exit) * t.qty;
          trades.push(t);
          open = null;
          continue;
        }
      }
    }

    // New signal check
    if (!open) {
      const sig = analyzeAt(candles, i);
      if (!sig || sig.signal === "HOLD" || !sig.safeToTrade) continue;

      // ═══ ATR-based SL/Target (matching live bot v6.3) ═══
      const stopDist = Math.max(
        sig.price * STRATEGY.SL_PCT,
        sig.atrValue * STRATEGY.ATR_SL_MULTIPLIER
      );
      const targetDist = Math.max(
        sig.price * STRATEGY.TARGET_PCT,
        sig.atrValue * STRATEGY.ATR_TARGET_MULTIPLIER
      );

      const qty = Math.max(1, Math.floor(STRATEGY.RISK_PER_TRADE / stopDist));

      open = {
        symbol,
        signal: sig.signal,
        entry: sig.price,
        entryTime: c.time,
        qty,
        initialSL: sig.signal === "BUY" ? sig.price - stopDist : sig.price + stopDist,
        currentSL: sig.signal === "BUY" ? sig.price - stopDist : sig.price + stopDist,
        target: sig.signal === "BUY" ? sig.price + targetDist : sig.price - targetDist,
        confidence: sig.confidence,
        rsi: sig.indicators.rsi,
        adx: sig.indicators.adx,
      };
    }
  }

  if (open) {
    const last = candles[candles.length - 1];
    open.exit = last.c;
    open.exitTime = last.time;
    open.exitReason = "END";
    open.pnl = (open.exit - open.entry) * open.qty * (open.signal === "BUY" ? 1 : -1);
    trades.push(open);
  }
  return trades;
}

// ═══════════════════════════════════════════════════════════════════════════
// METRICS (unchanged)
// ═══════════════════════════════════════════════════════════════════════════
function calculateMetrics(allTrades, config) {
  const total = allTrades.length;
  if (total === 0) return { total: 0, verdict: "NO_TRADES", verdictColor: "orange" };

  const wins = allTrades.filter(t => t.pnl > 0);
  const losses = allTrades.filter(t => t.pnl <= 0);
  const totalPnL = allTrades.reduce((s, t) => s + t.pnl, 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin;

  let peak = 0, maxDD = 0, running = 0;
  const equityCurve = [];
  for (const t of allTrades) {
    running += t.pnl;
    equityCurve.push({ time: t.exitTime, pnl: running });
    if (running > peak) peak = running;
    if (peak - running > maxDD) maxDD = peak - running;
  }

  let maxConsecLosses = 0, cur = 0;
  for (const t of allTrades) {
    if (t.pnl < 0) { cur++; maxConsecLosses = Math.max(maxConsecLosses, cur); }
    else cur = 0;
  }

  const bySymbol = {};
  for (const t of allTrades) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { trades: 0, wins: 0, pnl: 0 };
    bySymbol[t.symbol].trades++;
    if (t.pnl > 0) bySymbol[t.symbol].wins++;
    bySymbol[t.symbol].pnl += t.pnl;
  }
  for (const s in bySymbol) {
    bySymbol[s].winRate = (bySymbol[s].wins / bySymbol[s].trades * 100).toFixed(1);
    bySymbol[s].pnl = parseFloat(bySymbol[s].pnl.toFixed(2));
  }

  const byExitReason = {
    TARGET: allTrades.filter(t => t.exitReason === "TARGET").length,
    SL:     allTrades.filter(t => t.exitReason === "SL").length,
    EOD:    allTrades.filter(t => t.exitReason === "EOD").length,
    END:    allTrades.filter(t => t.exitReason === "END").length,
  };

  const winRate = (wins.length / total * 100).toFixed(2);
  const returnPct = (totalPnL / config.capital * 100).toFixed(2);

  // ═══ NEW: Verdict adjusted for 1:4 risk-reward ═══
  // With 1:4 RR, even 30% win rate is highly profitable
  let verdict = "POOR", verdictColor = "red";
  const wr = parseFloat(winRate), pf = parseFloat(profitFactor.toFixed(2));

  if (totalPnL > 0 && wr >= 40 && pf >= 2.0) { verdict = "EXCELLENT"; verdictColor = "green"; }
  else if (totalPnL > 0 && wr >= 30 && pf >= 1.5) { verdict = "GOOD"; verdictColor = "green"; }
  else if (totalPnL > 0 && pf >= 1.2) { verdict = "MARGINAL"; verdictColor = "orange"; }
  else if (totalPnL > 0) { verdict = "BREAK_EVEN"; verdictColor = "orange"; }

  return {
    total, wins: wins.length, losses: losses.length,
    winRate, totalPnL: parseFloat(totalPnL.toFixed(2)),
    returnPct, profitFactor: parseFloat(profitFactor.toFixed(2)),
    avgWin: parseFloat((wins.length ? grossWin / wins.length : 0).toFixed(2)),
    avgLoss: parseFloat((losses.length ? -grossLoss / losses.length : 0).toFixed(2)),
    best: parseFloat(Math.max(...allTrades.map(t => t.pnl)).toFixed(2)),
    worst: parseFloat(Math.min(...allTrades.map(t => t.pnl)).toFixed(2)),
    maxDrawdown: parseFloat(maxDD.toFixed(2)),
    maxConsecLosses,
    expectancy: parseFloat((totalPnL / total).toFixed(2)),
    bySymbol, byExitReason,
    equityCurve: equityCurve.slice(-100),
    verdict, verdictColor,
    strategyVersion: "v6.3",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// REST ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════
export function addBacktestEndpoints(app, state, auth) {

  app.post("/api/backtest/run", auth, async (req, res) => {
    const { days = 30, symbols, capital = 250000 } = req.body;
    const backtestId = `bt-${Date.now()}`;
    const symList = symbols?.length ? symbols : [
      "RELIANCE","HDFCBANK","ICICIBANK","INFY","TCS","HINDUNILVR",
      "SBIN","LT","KOTAKBANK","AXISBANK","BAJFINANCE","MARUTI",
      "SUNPHARMA","TITAN","HCLTECH","POWERGRID","JSWSTEEL","WIPRO",
      "ASIANPAINT","NTPC"
    ];

    res.json({
      backtestId,
      message: "Backtest started · v6.3 strategy",
      status: "running",
      estimatedTime: `${Math.ceil(symList.length * 0.8)}s`,
    });

    runBacktest(backtestId, symList, days, { capital }, state);
  });

  app.get("/api/backtest/:id", auth, (req, res) => {
    const result = backtestCache.get(req.params.id);
    const running = runningBacktests.get(req.params.id);
    if (result) res.json({ status: "completed", ...result });
    else if (running) res.json({ status: "running", progress: running });
    else res.status(404).json({ error: "Backtest not found" });
  });

  app.get("/api/backtest", auth, (req, res) => {
    const list = [...backtestCache.entries()].map(([id, r]) => ({
      id,
      runDate: r.runDate,
      days: r.config.days,
      symbols: r.config.symbols.length,
      totalTrades: r.metrics.total,
      totalPnL: r.metrics.totalPnL,
      winRate: r.metrics.winRate,
      verdict: r.metrics.verdict,
      strategyVersion: r.metrics.strategyVersion || "v6.2",
    })).reverse();
    res.json(list.slice(0, 20));
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// RUNNER
// ═══════════════════════════════════════════════════════════════════════════
async function runBacktest(id, symbols, days, config, state) {
  runningBacktests.set(id, { done: 0, total: symbols.length, currentSymbol: "" });

  const allTrades = [];
  const perSymbol = {};

  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    runningBacktests.set(id, { done: i, total: symbols.length, currentSymbol: sym });

    const candles = await fetchHistorical(sym, days, state);
    if (!candles?.length) {
      perSymbol[sym] = { error: "no data", trades: 0 };
      await new Promise(r => setTimeout(r, 200));
      continue;
    }

    const trades = simulate(sym, candles, config);
    allTrades.push(...trades);
    perSymbol[sym] = {
      candles: candles.length,
      trades: trades.length,
      pnl: trades.reduce((s, t) => s + t.pnl, 0).toFixed(2),
    };
    await new Promise(r => setTimeout(r, 300));
  }

  const metrics = calculateMetrics(allTrades, config);

  const result = {
    backtestId: id,
    runDate: new Date().toISOString(),
    config: { days, symbols, capital: config.capital, strategy: "v6.3" },
    metrics,
    perSymbol,
    trades: allTrades.slice(0, 500).map(t => ({
      symbol: t.symbol, signal: t.signal,
      entry: t.entry, exit: t.exit, qty: t.qty,
      pnl: parseFloat(t.pnl.toFixed(2)),
      exitReason: t.exitReason,
      entryTime: t.entryTime?.toISOString(),
      exitTime: t.exitTime?.toISOString(),
    })),
  };

  backtestCache.set(id, result);
  runningBacktests.delete(id);

  try {
    if (!fs.existsSync("./backtests")) fs.mkdirSync("./backtests");
    fs.writeFileSync(`./backtests/${id}.json`, JSON.stringify(result, null, 2));
  } catch {}

  console.log(`✅ Backtest ${id} (v6.3): ${metrics.total} trades · ${metrics.winRate}% win · ₹${metrics.totalPnL} · ${metrics.verdict}`);
}
