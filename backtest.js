// ═══════════════════════════════════════════════════════════════════════════
// NSE TradeAI · Backtest Engine
// Runs strategy on historical data and reports performance
// Usage: node backtest.js [days] [symbols]
// Example: node backtest.js 30 RELIANCE,HDFCBANK,TCS
// ═══════════════════════════════════════════════════════════════════════════

import axios from "axios";
import { authenticator } from "otplib";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ═══ CONFIG ════════════════════════════════════════════════════════════════
const BACKTEST = {
  CAPITAL:           250000,
  RISK_PER_TRADE:    1000,
  REWARD_RATIO:      2,
  DAILY_LOSS_CAP:    2500,
  SL_PCT:            0.008,
  TARGET_PCT:        0.016,
  SIGNAL_SCORE_BUY:  2.0,
  SIGNAL_SCORE_SELL: -2.0,
  MIN_CONFLUENCE:    2,
  MIN_CONFIDENCE:    55,
  MIN_CANDLES:       15,

  DEFAULT_SYMBOLS: [
    "RELIANCE","HDFCBANK","ICICIBANK","INFY","TCS","HINDUNILVR","ITC",
    "SBIN","LT","KOTAKBANK","AXISBANK","BAJFINANCE","MARUTI","SUNPHARMA",
    "TITAN","HCLTECH","POWERGRID","TATASTEEL","JSWSTEEL","WIPRO"
  ],
};

const ENV = {
  ANGEL_CLIENT_ID:  process.env.ANGEL_CLIENT_ID,
  ANGEL_API_KEY:    process.env.ANGEL_API_KEY,
  ANGEL_MPIN:       process.env.ANGEL_MPIN,
  ANGEL_TOTP_TOKEN: process.env.ANGEL_TOTP_TOKEN,
};

let angelAuth = null;
let scripMaster = null;

// ═══ ANGEL AUTH ════════════════════════════════════════════════════════════
async function authenticate() {
  console.log("🔐 Authenticating...");
  const totp = authenticator.generate(ENV.ANGEL_TOTP_TOKEN);
  const res = await axios.post(
    "https://apiconnect.angelbroking.com/rest/auth/angelbroking/user/v1/loginByPassword",
    { clientcode: ENV.ANGEL_CLIENT_ID, password: ENV.ANGEL_MPIN, totp },
    {
      headers: {
        "Content-Type": "application/json", "Accept": "application/json",
        "X-UserType": "USER", "X-SourceID": "WEB",
        "X-ClientLocalIP": "192.168.1.1", "X-ClientPublicIP": "103.0.0.1",
        "X-MACAddress": "00:00:00:00:00:00", "X-PrivateKey": ENV.ANGEL_API_KEY,
      }
    }
  );
  angelAuth = res.data?.data?.jwtToken;
  if (!angelAuth) throw new Error("Auth failed");
  console.log("✅ Authenticated");
}

function apiHeaders() {
  return {
    "Authorization": `Bearer ${angelAuth}`,
    "Content-Type": "application/json", "Accept": "application/json",
    "X-UserType": "USER", "X-SourceID": "WEB",
    "X-ClientLocalIP": "192.168.1.1", "X-ClientPublicIP": "103.0.0.1",
    "X-MACAddress": "00:00:00:00:00:00", "X-PrivateKey": ENV.ANGEL_API_KEY,
  };
}

// ═══ SCRIP MASTER ══════════════════════════════════════════════════════════
async function loadScripMaster() {
  const cachePath = "./scrip-master.json";
  if (fs.existsSync(cachePath)) {
    scripMaster = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    console.log(`✅ Scrip master from cache: ${scripMaster.length} items`);
    return;
  }
  console.log("⬇️ Downloading scrip master...");
  const res = await axios.get(
    "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json",
    { timeout: 120000, maxContentLength: 200 * 1024 * 1024 }
  );
  scripMaster = res.data;
  fs.writeFileSync(cachePath, JSON.stringify(scripMaster));
  console.log(`✅ Scrip master loaded: ${scripMaster.length}`);
}

function getToken(symbol) {
  const match = scripMaster.find(s => s.symbol === `${symbol}-EQ` && s.exch_seg === "NSE");
  return match?.token || null;
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
async function fetchHistorical(symbol, days) {
  const token = getToken(symbol);
  if (!token) {
    console.log(`  ⚠️ ${symbol}: no token`);
    return null;
  }
  const { from, to } = getHistoricalRange(days);
  try {
    const res = await axios.post(
      "https://apiconnect.angelbroking.com/rest/secure/angelbroking/historical/v1/getCandleData",
      {
        exchange: "NSE", symboltoken: token,
        interval: "FIVE_MINUTE", fromdate: from, todate: to,
      },
      { headers: apiHeaders(), timeout: 30000 }
    );
    const data = res.data?.data || [];
    return data.map(c => ({
      time: new Date(c[0]),
      o: parseFloat(c[1]), h: parseFloat(c[2]),
      l: parseFloat(c[3]), c: parseFloat(c[4]),
      v: parseInt(c[5]),
    }));
  } catch (e) {
    console.log(`  ⚠️ ${symbol}: ${e.message}`);
    return null;
  }
}

// ═══ INDICATORS ════════════════════════════════════════════════════════════
function ema(v, p) { if (v.length < p) return v[v.length-1] || 0; const k = 2/(p+1); let e = v.slice(0,p).reduce((a,b)=>a+b,0)/p; for (let i=p; i<v.length; i++) e = v[i]*k + e*(1-k); return e; }
function sma(v, p) { if (v.length < p) return v[v.length-1] || 0; return v.slice(-p).reduce((a,b)=>a+b,0)/p; }
function rsi(c, p=14) { if (c.length < p+1) return 50; const ch = c.slice(1).map((x,i) => x-c[i]); const g = ch.map(x => x>0?x:0); const l = ch.map(x => x<0?-x:0); let ag = g.slice(0,p).reduce((a,b)=>a+b,0)/p; let al = l.slice(0,p).reduce((a,b)=>a+b,0)/p; for (let i=p; i<ch.length; i++) { ag = (ag*(p-1)+g[i])/p; al = (al*(p-1)+l[i])/p; } return 100 - 100/(1 + ag/(al||0.001)); }
function macd(c) { return { bullish: ema(c,12) > ema(c,26) }; }
function vwap(cs) { if (!cs.length) return 0; let pv=0, tv=0; for (const c of cs) { pv += ((c.h+c.l+c.c)/3)*c.v; tv += c.v; } return tv>0 ? pv/tv : cs[cs.length-1].c; }
function atr(cs, p=14) { if (cs.length < p+1) return 0; const trs = []; for (let i=1; i<cs.length; i++) { const h=cs[i].h,l=cs[i].l,pc=cs[i-1].c; trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc))); } return sma(trs.slice(-p), p); }
function adx(cs, p=14) { if (cs.length < p*2) return {adx:0,plusDI:0,minusDI:0,trending:false}; const pdms=[],mdms=[],trs=[]; for (let i=1; i<cs.length; i++) { const um=cs[i].h-cs[i-1].h, dm=cs[i-1].l-cs[i].l; pdms.push(um>dm && um>0 ? um : 0); mdms.push(dm>um && dm>0 ? dm : 0); const h=cs[i].h,l=cs[i].l,pc=cs[i-1].c; trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc))); } const stt=sma(trs.slice(-p),p), spm=sma(pdms.slice(-p),p), smm=sma(mdms.slice(-p),p); const pdi=(spm/(stt||1))*100, mdi=(smm/(stt||1))*100; return { plusDI:pdi, minusDI:mdi, adx: Math.abs(pdi-mdi)/((pdi+mdi)||1)*100, trending: true }; }
function supertrend(cs, p=10, m=3) { if (cs.length < p) return {trend:"neutral"}; const a=atr(cs,p), l=cs[cs.length-1]; const hl2=(l.h+l.l)/2, ub=hl2+m*a, lb=hl2-m*a; return { trend: l.c>ub ? "bull" : l.c<lb ? "bear" : "neutral" }; }

// ═══ STRATEGY (matches bot-server.js v6.2) ═════════════════════════════════
function analyzeAtIndex(candles, i) {
  const window = candles.slice(Math.max(0, i - 100), i + 1);
  if (window.length < BACKTEST.MIN_CANDLES) return null;

  const closes = window.map(c => c.c);
  const vols = window.map(c => c.v);
  const price = closes[closes.length - 1];
  const R = rsi(closes);
  const M = macd(closes);
  const e9 = ema(closes, 9), e21 = ema(closes, 21), e50 = ema(closes, 50);
  const vw = vwap(window);
  const ad = adx(window);
  const st = supertrend(window);
  const avgVol = vols.slice(-20).reduce((a,b) => a+b, 0) / Math.min(20, vols.length);
  const volRatio = avgVol > 0 ? vols[vols.length-1] / avgVol : 1;

  let score = 0, bullCount = 0, bearCount = 0;

  if (R < 40) { score += 2; bullCount++; }
  else if (R > 60) { score -= 2; bearCount++; }

  if (M.bullish) { score += 1.5; bullCount++; }
  else { score -= 1.5; bearCount++; }

  if (e9 > e21 && e21 > e50) { score += 2; bullCount++; }
  else if (e9 < e21 && e21 < e50) { score -= 2; bearCount++; }
  else if (e9 > e21) score += 0.5;
  else score -= 0.5;

  if (price > vw * 1.002) { score += 1.5; bullCount++; }
  else if (price < vw * 0.998) { score -= 1.5; bearCount++; }

  if (st.trend === "bull") { score += 1; bullCount++; }
  else if (st.trend === "bear") { score -= 1; bearCount++; }

  if (volRatio > 1.5) score += Math.sign(score) * 1;

  let signal = "HOLD", confidence = 50;
  if (score >= BACKTEST.SIGNAL_SCORE_BUY) { signal = "BUY"; confidence = Math.min(52 + score*4, 80); }
  else if (score <= BACKTEST.SIGNAL_SCORE_SELL) { signal = "SELL"; confidence = Math.min(52 + Math.abs(score)*4, 78); }

  const maxConf = Math.max(bullCount, bearCount);
  const safeToTrade = maxConf >= BACKTEST.MIN_CONFLUENCE &&
                       confidence >= BACKTEST.MIN_CONFIDENCE;

  return {
    signal, score, confidence, safeToTrade,
    price, rsi: R, volRatio, maxConf,
  };
}

// ═══ BACKTEST SIMULATION ═══════════════════════════════════════════════════
function simulateTrades(symbol, candles) {
  const trades = [];
  let openTrade = null;

  for (let i = BACKTEST.MIN_CANDLES; i < candles.length; i++) {
    const candle = candles[i];

    // Skip outside market hours (9:30 AM - 3:00 PM)
    const h = candle.time.getHours();
    const m = candle.time.getMinutes();
    const mins = h * 60 + m;
    if (mins < 570 || mins > 900) {
      // End of day — close any open MIS trade at 3:15 PM
      if (openTrade && mins >= 915) {
        openTrade.exit = candle.c;
        openTrade.exitTime = candle.time;
        openTrade.exitReason = "EOD";
        openTrade.pnl = (openTrade.exit - openTrade.entry) * openTrade.qty * (openTrade.signal === "BUY" ? 1 : -1);
        trades.push(openTrade);
        openTrade = null;
      }
      continue;
    }

    // Check open trade for exits (trailing SL + target)
    if (openTrade) {
      const trade = openTrade;

      // Update trailing SL (moves up only for BUY)
      if (trade.signal === "BUY") {
        const gain = candle.c - trade.entry;
        if (gain > 0) {
          const newSL = trade.initialSL + gain;
          if (newSL > trade.currentSL) trade.currentSL = newSL;
        }
        // Check SL hit
        if (candle.l <= trade.currentSL) {
          trade.exit = trade.currentSL;
          trade.exitTime = candle.time;
          trade.exitReason = "SL";
          trade.pnl = (trade.exit - trade.entry) * trade.qty;
          trades.push(trade);
          openTrade = null;
          continue;
        }
        // Check target hit
        if (candle.h >= trade.target) {
          trade.exit = trade.target;
          trade.exitTime = candle.time;
          trade.exitReason = "TARGET";
          trade.pnl = (trade.exit - trade.entry) * trade.qty;
          trades.push(trade);
          openTrade = null;
          continue;
        }
      } else {
        // SELL logic (for shorts)
        const gain = trade.entry - candle.c;
        if (gain > 0) {
          const newSL = trade.initialSL - gain;
          if (newSL < trade.currentSL) trade.currentSL = newSL;
        }
        if (candle.h >= trade.currentSL) {
          trade.exit = trade.currentSL;
          trade.exitTime = candle.time;
          trade.exitReason = "SL";
          trade.pnl = (trade.entry - trade.exit) * trade.qty;
          trades.push(trade);
          openTrade = null;
          continue;
        }
        if (candle.l <= trade.target) {
          trade.exit = trade.target;
          trade.exitTime = candle.time;
          trade.exitReason = "TARGET";
          trade.pnl = (trade.entry - trade.exit) * trade.qty;
          trades.push(trade);
          openTrade = null;
          continue;
        }
      }
    }

    // Only look for new signals if no open trade
    if (!openTrade) {
      const sig = analyzeAtIndex(candles, i);
      if (!sig || sig.signal === "HOLD" || !sig.safeToTrade) continue;

      const stopDist = sig.price * BACKTEST.SL_PCT;
      const targetDist = sig.price * BACKTEST.TARGET_PCT;
      const qty = Math.max(1, Math.floor(BACKTEST.RISK_PER_TRADE / stopDist));

      openTrade = {
        symbol,
        signal: sig.signal,
        entry: sig.price,
        entryTime: candle.time,
        qty,
        initialSL: sig.signal === "BUY" ? sig.price - stopDist : sig.price + stopDist,
        currentSL: sig.signal === "BUY" ? sig.price - stopDist : sig.price + stopDist,
        target: sig.signal === "BUY" ? sig.price + targetDist : sig.price - targetDist,
        confidence: sig.confidence,
        rsi: sig.rsi,
      };
    }
  }

  // Close any remaining open trade
  if (openTrade) {
    const last = candles[candles.length - 1];
    openTrade.exit = last.c;
    openTrade.exitTime = last.time;
    openTrade.exitReason = "END_OF_DATA";
    openTrade.pnl = (openTrade.exit - openTrade.entry) * openTrade.qty * (openTrade.signal === "BUY" ? 1 : -1);
    trades.push(openTrade);
  }

  return trades;
}

// ═══ METRICS ═══════════════════════════════════════════════════════════════
function calculateMetrics(allTrades) {
  const total = allTrades.length;
  if (total === 0) {
    return { total: 0, wins: 0, losses: 0, winRate: 0, totalPnL: 0 };
  }

  const wins = allTrades.filter(t => t.pnl > 0);
  const losses = allTrades.filter(t => t.pnl <= 0);
  const totalPnL = allTrades.reduce((s, t) => s + t.pnl, 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const best = allTrades.reduce((b, t) => t.pnl > b.pnl ? t : b, allTrades[0]);
  const worst = allTrades.reduce((w, t) => t.pnl < w.pnl ? t : w, allTrades[0]);

  // Max drawdown calculation
  let peak = 0, maxDD = 0, runningPnL = 0;
  for (const t of allTrades) {
    runningPnL += t.pnl;
    if (runningPnL > peak) peak = runningPnL;
    const dd = peak - runningPnL;
    if (dd > maxDD) maxDD = dd;
  }

  // Consecutive losses
  let maxConsecLosses = 0, curLossStreak = 0;
  for (const t of allTrades) {
    if (t.pnl < 0) { curLossStreak++; maxConsecLosses = Math.max(maxConsecLosses, curLossStreak); }
    else curLossStreak = 0;
  }

  // Profit factor
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin;

  // Per-symbol stats
  const bySymbol = {};
  for (const t of allTrades) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { trades: 0, wins: 0, pnl: 0 };
    bySymbol[t.symbol].trades++;
    if (t.pnl > 0) bySymbol[t.symbol].wins++;
    bySymbol[t.symbol].pnl += t.pnl;
  }
  for (const s in bySymbol) {
    bySymbol[s].winRate = bySymbol[s].wins / bySymbol[s].trades * 100;
    bySymbol[s].avgPnL = bySymbol[s].pnl / bySymbol[s].trades;
  }

  // Per exit-reason
  const byExitReason = {
    TARGET: allTrades.filter(t => t.exitReason === "TARGET").length,
    SL:     allTrades.filter(t => t.exitReason === "SL").length,
    EOD:    allTrades.filter(t => t.exitReason === "EOD").length,
  };

  return {
    total, wins: wins.length, losses: losses.length,
    winRate: (wins.length / total * 100).toFixed(2),
    totalPnL: totalPnL.toFixed(2),
    avgWin: avgWin.toFixed(2),
    avgLoss: avgLoss.toFixed(2),
    best: best.pnl.toFixed(2),
    worst: worst.pnl.toFixed(2),
    maxDrawdown: maxDD.toFixed(2),
    maxConsecLosses,
    profitFactor: profitFactor.toFixed(2),
    returnPct: (totalPnL / BACKTEST.CAPITAL * 100).toFixed(2),
    expectancy: (totalPnL / total).toFixed(2),
    bySymbol, byExitReason,
  };
}

// ═══ MAIN ══════════════════════════════════════════════════════════════════
async function main() {
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("   NSE TradeAI · BACKTEST ENGINE");
  console.log("═══════════════════════════════════════════════════════════\n");

  const args = process.argv.slice(2);
  const days = parseInt(args[0]) || 30;
  const symbols = args[1] ? args[1].split(",") : BACKTEST.DEFAULT_SYMBOLS;

  console.log(`📅 Period: Last ${days} trading days`);
  console.log(`📊 Stocks: ${symbols.join(", ")}`);
  console.log(`💰 Capital: ₹${BACKTEST.CAPITAL.toLocaleString("en-IN")}`);
  console.log(`🎯 Risk/trade: ₹${BACKTEST.RISK_PER_TRADE} · RR 1:${BACKTEST.REWARD_RATIO}\n`);

  await authenticate();
  await loadScripMaster();

  const allTrades = [];
  const perSymbolResults = {};

  for (const symbol of symbols) {
    process.stdout.write(`📊 ${symbol.padEnd(12)}`);
    const candles = await fetchHistorical(symbol, days);
    if (!candles || candles.length === 0) {
      console.log("  no data");
      continue;
    }
    const trades = simulateTrades(symbol, candles);
    const pnl = trades.reduce((s, t) => s + t.pnl, 0);
    const wins = trades.filter(t => t.pnl > 0).length;
    console.log(`  ${candles.length} candles · ${trades.length} trades · ${wins}W ${trades.length-wins}L · ₹${pnl.toFixed(0)}`);
    allTrades.push(...trades);
    perSymbolResults[symbol] = { candles: candles.length, trades, pnl };
    await new Promise(r => setTimeout(r, 300));
  }

  const metrics = calculateMetrics(allTrades);

  // ═══ REPORT ═══════════════════════════════════════════════════════════════
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("   BACKTEST RESULTS");
  console.log("═══════════════════════════════════════════════════════════\n");

  console.log("📊 OVERALL PERFORMANCE:");
  console.log(`   Total Trades:       ${metrics.total}`);
  console.log(`   Wins / Losses:      ${metrics.wins} / ${metrics.losses}`);
  console.log(`   Win Rate:           ${metrics.winRate}%`);
  console.log(`   Total P&L:          ₹${metrics.totalPnL}`);
  console.log(`   Return on Capital:  ${metrics.returnPct}%`);
  console.log(`   Expectancy/trade:   ₹${metrics.expectancy}`);
  console.log();

  console.log("💹 TRADE STATISTICS:");
  console.log(`   Avg Win:            ₹${metrics.avgWin}`);
  console.log(`   Avg Loss:           ₹${metrics.avgLoss}`);
  console.log(`   Best Trade:         ₹${metrics.best}`);
  console.log(`   Worst Trade:        ₹${metrics.worst}`);
  console.log(`   Profit Factor:      ${metrics.profitFactor}  ${parseFloat(metrics.profitFactor) > 1.5 ? "✅ Good" : parseFloat(metrics.profitFactor) > 1.0 ? "⚠️ Marginal" : "❌ Losing"}`);
  console.log();

  console.log("🛡️ RISK METRICS:");
  console.log(`   Max Drawdown:       ₹${metrics.maxDrawdown}`);
  console.log(`   Max Consec Losses:  ${metrics.maxConsecLosses}`);
  console.log();

  console.log("🚪 EXIT BREAKDOWN:");
  console.log(`   Target hit:         ${metrics.byExitReason.TARGET} (${(metrics.byExitReason.TARGET/metrics.total*100).toFixed(0)}%)`);
  console.log(`   SL hit:             ${metrics.byExitReason.SL} (${(metrics.byExitReason.SL/metrics.total*100).toFixed(0)}%)`);
  console.log(`   EOD square-off:     ${metrics.byExitReason.EOD} (${(metrics.byExitReason.EOD/metrics.total*100).toFixed(0)}%)`);
  console.log();

  console.log("🏆 TOP 5 PERFORMING STOCKS:");
  const topSymbols = Object.entries(metrics.bySymbol)
    .sort((a, b) => b[1].pnl - a[1].pnl)
    .slice(0, 5);
  topSymbols.forEach(([s, d]) => {
    console.log(`   ${s.padEnd(12)} ${d.trades} trades · ${d.winRate.toFixed(0)}% win · ₹${d.pnl.toFixed(0)}`);
  });
  console.log();

  console.log("💀 BOTTOM 5 PERFORMING STOCKS:");
  const botSymbols = Object.entries(metrics.bySymbol)
    .sort((a, b) => a[1].pnl - b[1].pnl)
    .slice(0, 5);
  botSymbols.forEach(([s, d]) => {
    console.log(`   ${s.padEnd(12)} ${d.trades} trades · ${d.winRate.toFixed(0)}% win · ₹${d.pnl.toFixed(0)}`);
  });
  console.log();

  // Verdict
  console.log("═══════════════════════════════════════════════════════════");
  console.log("   VERDICT");
  console.log("═══════════════════════════════════════════════════════════");
  const pnl = parseFloat(metrics.totalPnL);
  const wr = parseFloat(metrics.winRate);
  const pf = parseFloat(metrics.profitFactor);
  if (pnl > 0 && wr >= 50 && pf >= 1.5) {
    console.log("   ✅ STRATEGY IS PROFITABLE — ready for paper trading");
  } else if (pnl > 0 && pf >= 1.2) {
    console.log("   ⚠️ MARGINAL — refine before going live");
  } else {
    console.log("   ❌ STRATEGY NEEDS TUNING — do not risk real money yet");
  }
  console.log();

  // Save detailed results
  const report = {
    runDate: new Date().toISOString(),
    config: { days, symbols, capital: BACKTEST.CAPITAL, risk: BACKTEST.RISK_PER_TRADE },
    metrics,
    allTrades: allTrades.map(t => ({
      symbol: t.symbol, signal: t.signal,
      entry: t.entry, exit: t.exit,
      entryTime: t.entryTime?.toISOString(),
      exitTime: t.exitTime?.toISOString(),
      qty: t.qty, pnl: t.pnl,
      exitReason: t.exitReason, confidence: t.confidence,
    })),
  };

  const fname = `backtest-${new Date().toISOString().slice(0,10)}-${days}d.json`;
  fs.writeFileSync(fname, JSON.stringify(report, null, 2));
  console.log(`📁 Full report saved: ${fname}\n`);

  // CSV for Excel
  const csvName = fname.replace(".json", ".csv");
  const csv = [
    "Symbol,Signal,Entry,Exit,Qty,PnL,ExitReason,EntryTime,ExitTime",
    ...allTrades.map(t => `${t.symbol},${t.signal},${t.entry},${t.exit},${t.qty},${t.pnl.toFixed(2)},${t.exitReason},${t.entryTime?.toISOString()},${t.exitTime?.toISOString()}`)
  ].join("\n");
  fs.writeFileSync(csvName, csv);
  console.log(`📊 CSV saved: ${csvName}\n`);
}

main().catch(e => {
  console.error(`\n💥 Error: ${e.message}`);
  console.error(e);
  process.exit(1);
});
