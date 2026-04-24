// ═══════════════════════════════════════════════════════════════════════════
// NSE TradeAI · Backtest API (Mobile-triggered)
// Adds REST endpoints to run backtests from mobile PWA
// Include this in bot-server.js startup: addBacktestEndpoints(app, state, auth)
// ═══════════════════════════════════════════════════════════════════════════

import axios from "axios";
import fs from "fs";

// In-memory cache of backtest results
const backtestCache = new Map();
const runningBacktests = new Map();  // Track progress

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

// ═══ INDICATORS (matching live bot logic) ══════════════════════════════════
const ema = (v, p) => { if (v.length < p) return v[v.length-1] || 0; const k = 2/(p+1); let e = v.slice(0,p).reduce((a,b) => a+b, 0)/p; for (let i=p; i<v.length; i++) e = v[i]*k + e*(1-k); return e; };
const sma = (v, p) => v.length < p ? (v[v.length-1] || 0) : v.slice(-p).reduce((a,b) => a+b, 0) / p;
function rsi(c, p=14) { if (c.length < p+1) return 50; const ch = c.slice(1).map((x,i) => x-c[i]); const g = ch.map(x => x>0?x:0); const l = ch.map(x => x<0?-x:0); let ag = g.slice(0,p).reduce((a,b) => a+b, 0)/p; let al = l.slice(0,p).reduce((a,b) => a+b, 0)/p; for (let i=p; i<ch.length; i++) { ag = (ag*(p-1)+g[i])/p; al = (al*(p-1)+l[i])/p; } return 100 - 100/(1 + ag/(al||0.001)); }
function vwap(cs) { if (!cs.length) return 0; let pv=0, tv=0; for (const c of cs) { pv += ((c.h+c.l+c.c)/3)*c.v; tv += c.v; } return tv>0 ? pv/tv : cs[cs.length-1].c; }

// ═══ STRATEGY ══════════════════════════════════════════════════════════════
function analyzeAt(candles, i) {
  const win = candles.slice(Math.max(0, i - 100), i + 1);
  if (win.length < 15) return null;
  const closes = win.map(c => c.c);
  const vols = win.map(c => c.v);
  const price = closes[closes.length-1];
  const R = rsi(closes);
  const macdBull = ema(closes, 12) > ema(closes, 26);
  const e9 = ema(closes, 9), e21 = ema(closes, 21), e50 = ema(closes, 50);
  const vw = vwap(win);
  const avgVol = vols.slice(-20).reduce((a,b) => a+b, 0) / Math.min(20, vols.length);
  const volRatio = avgVol > 0 ? vols[vols.length-1] / avgVol : 1;

  let score = 0, bullCount = 0, bearCount = 0;
  if (R < 40) { score += 2; bullCount++; }
  else if (R > 60) { score -= 2; bearCount++; }
  if (macdBull) { score += 1.5; bullCount++; }
  else { score -= 1.5; bearCount++; }
  if (e9 > e21 && e21 > e50) { score += 2; bullCount++; }
  else if (e9 < e21 && e21 < e50) { score -= 2; bearCount++; }
  else if (e9 > e21) score += 0.5;
  else score -= 0.5;
  if (price > vw * 1.002) { score += 1.5; bullCount++; }
  else if (price < vw * 0.998) { score -= 1.5; bearCount++; }
  if (volRatio > 1.5) score += Math.sign(score) * 1;

  let signal = "HOLD", confidence = 50;
  if (score >= 2) { signal = "BUY"; confidence = Math.min(52 + score*4, 80); }
  else if (score <= -2) { signal = "SELL"; confidence = Math.min(52 + Math.abs(score)*4, 78); }

  const maxConf = Math.max(bullCount, bearCount);
  const safeToTrade = maxConf >= 2 && confidence >= 55;
  return { signal, score, confidence, safeToTrade, price };
}

// ═══ SIMULATOR ═════════════════════════════════════════════════════════════
function simulate(symbol, candles, config) {
  const trades = [];
  let open = null;

  for (let i = 15; i < candles.length; i++) {
    const c = candles[i];
    const mins = c.time.getHours() * 60 + c.time.getMinutes();
    const inMarket = mins >= 570 && mins <= 900;

    // EOD squareoff
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
        // Trail SL up
        const gain = c.c - t.entry;
        if (gain > 0) {
          const newSL = t.initialSL + gain;
          if (newSL > t.currentSL) t.currentSL = newSL;
        }
        if (c.l <= t.currentSL) {
          t.exit = t.currentSL; t.exitTime = c.time; t.exitReason = "SL";
          t.pnl = (t.exit - t.entry) * t.qty;
          trades.push(t); open = null; continue;
        }
        if (c.h >= t.target) {
          t.exit = t.target; t.exitTime = c.time; t.exitReason = "TARGET";
          t.pnl = (t.exit - t.entry) * t.qty;
          trades.push(t); open = null; continue;
        }
      } else {
        const gain = t.entry - c.c;
        if (gain > 0) {
          const newSL = t.initialSL - gain;
          if (newSL < t.currentSL) t.currentSL = newSL;
        }
        if (c.h >= t.currentSL) {
          t.exit = t.currentSL; t.exitTime = c.time; t.exitReason = "SL";
          t.pnl = (t.entry - t.exit) * t.qty;
          trades.push(t); open = null; continue;
        }
        if (c.l <= t.target) {
          t.exit = t.target; t.exitTime = c.time; t.exitReason = "TARGET";
          t.pnl = (t.entry - t.exit) * t.qty;
          trades.push(t); open = null; continue;
        }
      }
    }

    // New signal check
    if (!open) {
      const sig = analyzeAt(candles, i);
      if (!sig || sig.signal === "HOLD" || !sig.safeToTrade) continue;
      const stopDist = sig.price * config.slPct;
      const targetDist = sig.price * config.targetPct;
      const qty = Math.max(1, Math.floor(config.riskPerTrade / stopDist));
      open = {
        symbol, signal: sig.signal,
        entry: sig.price, entryTime: c.time, qty,
        initialSL: sig.signal === "BUY" ? sig.price - stopDist : sig.price + stopDist,
        currentSL: sig.signal === "BUY" ? sig.price - stopDist : sig.price + stopDist,
        target: sig.signal === "BUY" ? sig.price + targetDist : sig.price - targetDist,
        confidence: sig.confidence,
      };
    }
  }

  if (open) {
    const last = candles[candles.length-1];
    open.exit = last.c; open.exitTime = last.time; open.exitReason = "END";
    open.pnl = (open.exit - open.entry) * open.qty * (open.signal === "BUY" ? 1 : -1);
    trades.push(open);
  }
  return trades;
}

// ═══ METRICS ═══════════════════════════════════════════════════════════════
function calculateMetrics(allTrades, config) {
  const total = allTrades.length;
  if (total === 0) return { total: 0, verdict: "NO_DATA" };

  const wins = allTrades.filter(t => t.pnl > 0);
  const losses = allTrades.filter(t => t.pnl <= 0);
  const totalPnL = allTrades.reduce((s,t) => s + t.pnl, 0);
  const grossWin = wins.reduce((s,t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s,t) => s + t.pnl, 0));
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

  // Daily P&L
  const dailyPnL = {};
  for (const t of allTrades) {
    const day = t.exitTime?.toISOString().slice(0, 10);
    if (!day) continue;
    dailyPnL[day] = (dailyPnL[day] || 0) + t.pnl;
  }

  const winRate = (wins.length / total * 100).toFixed(2);
  const returnPct = (totalPnL / config.capital * 100).toFixed(2);

  // Verdict
  let verdict = "POOR", verdictColor = "red";
  const wr = parseFloat(winRate), pf = parseFloat(profitFactor.toFixed(2));
  if (totalPnL > 0 && wr >= 55 && pf >= 1.5) { verdict = "EXCELLENT"; verdictColor = "green"; }
  else if (totalPnL > 0 && wr >= 45 && pf >= 1.3) { verdict = "GOOD"; verdictColor = "green"; }
  else if (totalPnL > 0 && pf >= 1.1) { verdict = "MARGINAL"; verdictColor = "orange"; }
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
    bySymbol, byExitReason, dailyPnL,
    equityCurve: equityCurve.slice(-100),  // limit size
    verdict, verdictColor,
  };
}

// ═══ ENDPOINTS ═════════════════════════════════════════════════════════════
export function addBacktestEndpoints(app, state, auth) {

  // Trigger backtest (async - returns ID, client polls for result)
  app.post("/api/backtest/run", auth, async (req, res) => {
    const {
      days = 30,
      symbols,
      slPct = 0.008,
      targetPct = 0.016,
      riskPerTrade = 1000,
      capital = 250000,
    } = req.body;

    const backtestId = `bt-${Date.now()}`;
    const symList = symbols?.length ? symbols : [
      "RELIANCE","HDFCBANK","ICICIBANK","INFY","TCS","HINDUNILVR",
      "SBIN","LT","KOTAKBANK","AXISBANK","BAJFINANCE","MARUTI",
      "SUNPHARMA","TITAN","HCLTECH","POWERGRID","JSWSTEEL","WIPRO"
    ];

    res.json({
      backtestId,
      message: "Backtest started",
      status: "running",
      estimatedTime: `${Math.ceil(symList.length * 0.8)}s`,
    });

    // Run async
    runBacktest(backtestId, symList, days, { slPct, targetPct, riskPerTrade, capital }, state);
  });

  // Check status / get result
  app.get("/api/backtest/:id", auth, (req, res) => {
    const result = backtestCache.get(req.params.id);
    const running = runningBacktests.get(req.params.id);
    if (result) {
      res.json({ status: "completed", ...result });
    } else if (running) {
      res.json({ status: "running", progress: running });
    } else {
      res.status(404).json({ error: "Backtest not found" });
    }
  });

  // List recent backtests
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
    })).reverse();
    res.json(list.slice(0, 20));
  });
}

// ═══ RUNNER ════════════════════════════════════════════════════════════════
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
      pnl: trades.reduce((s,t) => s + t.pnl, 0).toFixed(2),
    };
    await new Promise(r => setTimeout(r, 300));
  }

  const metrics = calculateMetrics(allTrades, config);

  const result = {
    backtestId: id,
    runDate: new Date().toISOString(),
    config: { days, symbols, ...config },
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

  // Save to disk for persistence
  try {
    if (!fs.existsSync("./backtests")) fs.mkdirSync("./backtests");
    fs.writeFileSync(`./backtests/${id}.json`, JSON.stringify(result, null, 2));
  } catch {}

  console.log(`✅ Backtest ${id} complete: ${metrics.total} trades, ${metrics.winRate}% win, ₹${metrics.totalPnL} PnL`);
}
