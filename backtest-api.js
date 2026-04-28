// ═══════════════════════════════════════════════════════════════════════════
// NSE TradeAI · Backtest API v7.1 — FIXED
//
// FIXES:
// ✅ Rolling index trend per-candle-date (not one value for whole period)
// ✅ analyzeSignal imported directly from bot-server (zero divergence)
// ✅ Proper IST datetime in every trade log row
// ✅ All charges broken out per trade
// ✅ Rate-limited historical fetch (1100ms gap)
// ═══════════════════════════════════════════════════════════════════════════

import axios from "axios";
import fs    from "fs";
import { analyzeSignal, state as botState } from "./bot-server.js";

const CFG = {
  RISK_PCT:              0.01,
  SL_PCT:                0.012,
  TARGET_PCT:            0.030,
  ATR_SL_MULT:           2.5,
  ATR_TARGET_MULT:       6.0,
  BREAKEVEN_TRIGGER_PCT: 0.012,
  PARTIAL_BOOK_PCT:      0.020,
  PARTIAL_BOOK_FRACTION: 0.50,
  MIN_CANDLES:           30,
  MIN_SCORE:             3.5,
  TRADING_START:         570,   // 9:30
  TRADING_END:           915,   // 3:15
  RATE_LIMIT_MS:         1100,
  CHARGES: {
    STT_PCT:0.001, BROKERAGE_FLAT:20, BROKERAGE_PCT:0.0003,
    GST_PCT:0.18, STAMP_PCT:0.00015, EXCHANGE_PCT:0.0000345,
    SEBI_PCT:0.000001, DP_CHARGE:15.93,
  },
  BANKING: ["HDFCBANK","ICICIBANK","SBIN","KOTAKBANK","AXISBANK","INDUSINDBK","BAJFINANCE","BAJAJFINSV","SBILIFE","HDFCLIFE"],
  FALLBACK: {
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
  IDX: { NIFTY:"99926000", NIFTYBANK:"99926009" },
};

const btCache   = new Map();
const btRunning = new Map();
const delay = ms => new Promise(r => setTimeout(r, ms));

// ── Helpers ─────────────────────────────────────────────────────────────────
function toIST(d) {
  const dt = typeof d==="string" ? new Date(d) : d;
  return new Date(dt.getTime() + dt.getTimezoneOffset()*60000 + 19800000);
}
function fmtDate(d) {
  const p=n=>String(n).padStart(2,"0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtIST(d) {
  if (!d) return "";
  return toIST(typeof d==="string"?new Date(d):d)
    .toLocaleString("en-IN",{day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:true});
}
function getRange(daysBack) {
  let end=toIST(new Date());
  if (end.getHours()<9) end.setDate(end.getDate()-1);
  while (end.getDay()===0||end.getDay()===6) end.setDate(end.getDate()-1);
  end.setHours(15,30,0,0);
  let start=new Date(end), count=0;
  while (count<daysBack) { start.setDate(start.getDate()-1); if (start.getDay()!==0&&start.getDay()!==6) count++; }
  start.setHours(9,15,0,0);
  return { fromdate:fmtDate(start), todate:fmtDate(end) };
}
function apiHdrs() {
  return {
    "Authorization":`Bearer ${botState.angelAuth}`,
    "Content-Type":"application/json","Accept":"application/json",
    "X-UserType":"USER","X-SourceID":"WEB",
    "X-ClientLocalIP":"192.168.1.1","X-ClientPublicIP":"103.0.0.1",
    "X-MACAddress":"00:00:00:00:00:00","X-PrivateKey":process.env.ANGEL_API_KEY,
  };
}
function getToken(sym) {
  if (botState.symbolTokens?.has(sym)) return botState.symbolTokens.get(sym);
  if (CFG.IDX[sym]) return CFG.IDX[sym];
  if (CFG.FALLBACK[sym]) return CFG.FALLBACK[sym];
  const m = botState.scripMaster;
  if (!m) return null;
  const hit = m.find(s=>s.symbol===`${sym}-EQ`&&s.exch_seg==="NSE")||m.find(s=>s.name===sym&&s.exch_seg==="NSE");
  return hit?.token||null;
}
async function fetchCandles(sym, interval, days, retries=2) {
  const token=getToken(sym);
  if (!token) return [];
  const {fromdate,todate}=getRange(days);
  for (let a=0;a<=retries;a++) {
    try {
      const res=await axios.post(
        "https://apiconnect.angelbroking.com/rest/secure/angelbroking/historical/v1/getCandleData",
        {exchange:"NSE",symboltoken:token,interval,fromdate,todate},
        {headers:apiHdrs(),timeout:20000}
      );
      return (res.data?.data||[]).map(c=>({time:new Date(c[0]),bucket:c[0],o:parseFloat(c[1]),h:parseFloat(c[2]),l:parseFloat(c[3]),c:parseFloat(c[4]),v:parseInt(c[5])}));
    } catch(e) {
      const s=e.response?.status;
      if (s===429&&a<retries){await delay(3000);continue;}
      if (s===401&&a<retries){await delay(1000);continue;}
      return [];
    }
  }
  return [];
}

// ── EMA helper (self-contained for rolling trend) ───────────────────────────
function _ema(v,p) {
  if (v.length<p) return v[v.length-1]||0;
  const k=2/(p+1); let e=v.slice(0,p).reduce((a,b)=>a+b,0)/p;
  for (let i=p;i<v.length;i++) e=v[i]*k+e*(1-k); return e;
}

// ── FIX: Build ROLLING index trend map (date → trend) ────────────────────
function buildRollingTrend(dailyCandles) {
  const map=new Map();
  if (!dailyCandles||dailyCandles.length<22) return map;
  const closes=dailyCandles.map(c=>c.c);
  for (let i=21;i<closes.length;i++) {
    const sl=closes.slice(0,i+1);
    const e9=_ema(sl,9), e21=_ema(sl,21);
    const dk=toIST(dailyCandles[i].time).toISOString().slice(0,10);
    let trend="neutral";
    if (e9>e21*1.001) trend="bullish";
    else if (e9<e21*0.999) trend="bearish";
    map.set(dk,trend);
  }
  return map;
}
function trendForDate(map, dateKey) {
  for (let d=0;d<7;d++) {
    const dt=new Date(dateKey); dt.setDate(dt.getDate()-d);
    const k=dt.toISOString().slice(0,10);
    if (map.has(k)) return map.get(k);
  }
  return "neutral";
}

// ── Charges ─────────────────────────────────────────────────────────────────
function calcCharges(buyVal,sellVal) {
  const C=CFG.CHARGES;
  const stt=(buyVal+sellVal)*C.STT_PCT;
  const br=Math.min(C.BROKERAGE_FLAT,buyVal*C.BROKERAGE_PCT)+Math.min(C.BROKERAGE_FLAT,sellVal*C.BROKERAGE_PCT);
  const ex=(buyVal+sellVal)*C.EXCHANGE_PCT;
  const se=(buyVal+sellVal)*C.SEBI_PCT;
  const gst=(br+ex+se)*C.GST_PCT;
  const st=buyVal*C.STAMP_PCT;
  const dp=C.DP_CHARGE;
  const total=stt+br+ex+se+gst+st+dp;
  return {stt:+stt.toFixed(2),brokerage:+br.toFixed(2),exchange:+ex.toFixed(2),sebi:+se.toFixed(2),gst:+gst.toFixed(2),stamp:+st.toFixed(2),dp:+dp.toFixed(2),total:+total.toFixed(2)};
}

// ── Simulator ────────────────────────────────────────────────────────────────
function simulate(sym,c5,c15,cD,nTrendMap,bnTrendMap,capital) {
  const trades=[];
  let open=null;
  for (let i=CFG.MIN_CANDLES;i<c5.length;i++) {
    const cv=c5[i];
    const cist=toIST(cv.time instanceof Date?cv.time:new Date(cv.time));
    const mins=cist.getHours()*60+cist.getMinutes();
    const inWin=mins>=CFG.TRADING_START&&mins<=CFG.TRADING_END;
    const dk=cist.toISOString().slice(0,10);

    if (open) {
      const t=open;
      if (t.signal==="BUY") {
        const pct=(cv.c-t.entry)/t.entry;
        if (!t.be&&pct>=CFG.BREAKEVEN_TRIGGER_PCT) { t.currentSL=+(t.entry*1.001).toFixed(2); t.be=true; t.bePrice=+cv.c.toFixed(2); t.beIST=fmtIST(cv.time); }
        if (!t.pb&&pct>=CFG.PARTIAL_BOOK_PCT) {
          const pq=Math.floor(t.originalQty*CFG.PARTIAL_BOOK_FRACTION);
          if (pq>0&&pq<t.qty) {
            const pc=calcCharges(t.entry*pq,cv.c*pq);
            t.pQty=pq; t.pPrice=+cv.c.toFixed(2); t.pIST=fmtIST(cv.time);
            t.pGross=+((cv.c-t.entry)*pq).toFixed(2); t.pChg=pc.total; t.pNet=+(t.pGross-pc.total).toFixed(2);
            t.qty-=pq; t.pb=true;
          }
        }
        if (t.pb) { const g=cv.c-t.entry; const ns=+(t.entry+g*0.8).toFixed(2); if (ns>t.currentSL) t.currentSL=ns; }
        else if (t.be) { const g=cv.c-t.entry; const ns=+(t.entry+g*0.5).toFixed(2); if (ns>t.currentSL) t.currentSL=ns; }
        if (cv.l<=t.currentSL){open=closeT(t,t.currentSL,"SL",cv.time,trades);continue;}
        if (cv.h>=t.target)   {open=closeT(t,t.target,"TARGET",cv.time,trades);continue;}
      }
      if (t.signal==="SELL") {
        const pct=(t.entry-cv.c)/t.entry;
        if (!t.be&&pct>=CFG.BREAKEVEN_TRIGGER_PCT){t.currentSL=+(t.entry*0.999).toFixed(2);t.be=true;}
        if (!t.pb&&pct>=CFG.PARTIAL_BOOK_PCT){const pq=Math.floor(t.originalQty*CFG.PARTIAL_BOOK_FRACTION);if(pq>0&&pq<t.qty){const pc=calcCharges(t.entry*pq,cv.c*pq);t.pGross=+((t.entry-cv.c)*pq).toFixed(2);t.pNet=+(t.pGross-pc.total).toFixed(2);t.qty-=pq;t.pb=true;}}
        if (cv.h>=t.currentSL){open=closeT(t,t.currentSL,"SL",cv.time,trades);continue;}
        if (cv.l<=t.target)   {open=closeT(t,t.target,"TARGET",cv.time,trades);continue;}
      }
    }

    if (!open&&inWin) {
      const s5=c5.slice(Math.max(0,i-300),i+1);
      const s15=c15.filter(c=>new Date(c.time)<=new Date(cv.time)).slice(-200);
      const sD=cD.filter(c=>new Date(c.time)<=new Date(cv.time)).slice(-100);
      const nT=trendForDate(nTrendMap,dk);
      const bnT=trendForDate(bnTrendMap,dk);
      const savedCap=botState.capital; botState.capital=capital;
      const sig=analyzeSignal(sym,s5,s15,sD,nT,bnT,false);
      botState.capital=savedCap;
      if (!sig||sig.rejected||sig.signal==="HOLD"||!sig.safeToTrade) continue;
      if (Math.abs(sig.score)<CFG.MIN_SCORE) continue;
      const sd=Math.max(sig.entry*CFG.SL_PCT,sig.indicators.atr*CFG.ATR_SL_MULT);
      const td=Math.max(sig.entry*CFG.TARGET_PCT,sig.indicators.atr*CFG.ATR_TARGET_MULT);
      const qty=Math.max(1,Math.floor((capital*CFG.RISK_PCT)/sd));
      open={
        symbol:sym, signal:sig.signal, entry:sig.entry,
        entryTime:cv.time instanceof Date?cv.time.toISOString():cv.time,
        entryTimeIST:fmtIST(cv.time), qty, originalQty:qty,
        sl:sig.signal==="BUY"?+(sig.entry-sd).toFixed(2):+(sig.entry+sd).toFixed(2),
        currentSL:sig.signal==="BUY"?+(sig.entry-sd).toFixed(2):+(sig.entry+sd).toFixed(2),
        target:sig.signal==="BUY"?+(sig.entry+td).toFixed(2):+(sig.entry-td).toFixed(2),
        be:false, bePrice:null, beIST:null,
        pb:false, pQty:0, pPrice:null, pIST:null, pGross:0, pNet:0, pChg:0,
        confidence:sig.confidence, score:sig.score,
        rsi:sig.indicators.rsi, adx:sig.indicators.adx, vwap:sig.indicators.vwap,
        supertrend:sig.indicators.supertrend, atr:sig.indicators.atr, volRatio:sig.indicators.volRatio,
        pattern:sig.indicators.pattern, macd:sig.indicators.checks?.macd||"—",
        ema:sig.indicators.checks?.ema||"—", bb:sig.indicators.checks?.bb||"—",
        trend15m:sig.indicators.trend15m, trendDaily:sig.indicators.trendDaily,
        indexTrend:CFG.BANKING.includes(sym)?bnT:nT,
        bullCount:sig.bullCount, bearCount:sig.bearCount,
      };
    }
  }
  if (open) { const last=c5[c5.length-1]; open=closeT(open,last.c,"END_OF_DATA",last.time,trades); }
  return trades;
}
function closeT(t,ep,reason,etime,trades) {
  t.exit=+ep.toFixed(2); t.exitTime=etime instanceof Date?etime.toISOString():etime; t.exitTimeIST=fmtIST(etime); t.exitReason=reason;
  const dir=t.signal==="BUY"?1:-1;
  const cg=+((t.exit-t.entry)*t.qty*dir).toFixed(2);
  const tg=+(cg+(t.pGross||0)).toFixed(2);
  const bv=t.entry*t.originalQty;
  const sv=t.exit*t.qty+(t.pPrice||0)*(t.pQty||0);
  t.charges=calcCharges(bv,sv); t.grossPnL=tg; t.netPnL=+(tg-t.charges.total).toFixed(2);
  t.capital=+(t.entry*t.originalQty).toFixed(2);
  trades.push(t); return null;
}

// ── Metrics ──────────────────────────────────────────────────────────────────
function calcMetrics(trades,capital) {
  const n=trades.length;
  if (!n) return {total:0,verdict:"NO_TRADES",verdictColor:"orange"};
  const wins=trades.filter(t=>t.netPnL>0), losses=trades.filter(t=>t.netPnL<=0);
  const tNet=+trades.reduce((s,t)=>s+t.netPnL,0).toFixed(2);
  const tGross=+trades.reduce((s,t)=>s+t.grossPnL,0).toFixed(2);
  const tChg=+trades.reduce((s,t)=>s+t.charges.total,0).toFixed(2);
  const gw=wins.reduce((s,t)=>s+t.netPnL,0);
  const gl=Math.abs(losses.reduce((s,t)=>s+t.netPnL,0));
  const pf=gl>0?gw/gl:gw;
  let peak=0,maxDD=0,run=0;
  const eq=[],dpnl={};
  for (const t of trades) {
    run+=t.netPnL; eq.push({time:t.exitTime,pnl:+run.toFixed(2),sym:t.symbol});
    if (run>peak) peak=run; const dd=peak-run; if (dd>maxDD) maxDD=dd;
    const d=t.exitTime?.slice(0,10); if (d) dpnl[d]=+((dpnl[d]||0)+t.netPnL).toFixed(2);
  }
  let mx=0,cr=0; for (const t of trades) {t.netPnL<0?(cr++,mx=Math.max(mx,cr)):(cr=0);}
  const bySym={};
  for (const t of trades) {
    if (!bySym[t.symbol]) bySym[t.symbol]={trades:0,wins:0,grossPnL:0,netPnL:0,totalCharges:0};
    bySym[t.symbol].trades++; if (t.netPnL>0) bySym[t.symbol].wins++;
    bySym[t.symbol].grossPnL=+(bySym[t.symbol].grossPnL+t.grossPnL).toFixed(2);
    bySym[t.symbol].netPnL=+(bySym[t.symbol].netPnL+t.netPnL).toFixed(2);
    bySym[t.symbol].totalCharges=+(bySym[t.symbol].totalCharges+t.charges.total).toFixed(2);
  }
  for (const s in bySym) bySym[s].winRate=+((bySym[s].wins/bySym[s].trades)*100).toFixed(1);
  const byR={};
  for (const t of trades) byR[t.exitReason]=(byR[t.exitReason]||0)+1;
  const aggChg={
    stt:+trades.reduce((s,t)=>s+t.charges.stt,0).toFixed(2),
    brokerage:+trades.reduce((s,t)=>s+t.charges.brokerage,0).toFixed(2),
    gst:+trades.reduce((s,t)=>s+t.charges.gst,0).toFixed(2),
    exchange:+trades.reduce((s,t)=>s+t.charges.exchange,0).toFixed(2),
    sebi:+trades.reduce((s,t)=>s+t.charges.sebi,0).toFixed(2),
    stamp:+trades.reduce((s,t)=>s+t.charges.stamp,0).toFixed(2),
    dp:+trades.reduce((s,t)=>s+t.charges.dp,0).toFixed(2),
    total:+tChg.toFixed(2),
  };
  const wr=+((wins.length/n)*100).toFixed(2), rp=+((tNet/capital)*100).toFixed(2);
  let verdict="POOR",vc="red";
  if (tNet>0&&wr>=50&&pf>=2.0){verdict="EXCELLENT";vc="green";}
  else if (tNet>0&&wr>=35&&pf>=1.5){verdict="GOOD";vc="green";}
  else if (tNet>0&&pf>=1.2){verdict="MARGINAL";vc="orange";}
  else if (tNet>0){verdict="BREAK_EVEN";vc="orange";}
  return {
    total:n, wins:wins.length, losses:losses.length, winRate:wr,
    totalGross:tGross, totalCharges:tChg, totalNet:tNet, returnPct:rp,
    profitFactor:+pf.toFixed(2),
    avgWin:+(wins.length?gw/wins.length:0).toFixed(2),
    avgLoss:+(losses.length?-gl/losses.length:0).toFixed(2),
    best:+Math.max(...trades.map(t=>t.netPnL)).toFixed(2),
    worst:+Math.min(...trades.map(t=>t.netPnL)).toFixed(2),
    maxDrawdown:+maxDD.toFixed(2), maxConsecLosses:mx,
    aggregatedCharges:aggChg, bySym, byReason:byR, dailyPnL:dpnl,
    equityCurve:eq.slice(-200), verdict, verdictColor:vc, strategyVersion:"v7.1",
  };
}

// ── Runner ───────────────────────────────────────────────────────────────────
async function runJob(id,symbols,days,capital) {
  btRunning.set(id,{done:0,total:symbols.length,currentSymbol:"",startedAt:new Date().toISOString()});
  const log=m=>console.log(`[BT ${id}] ${m}`);
  log("Fetching index daily (rolling trend)...");
  const nD=await fetchCandles("NIFTY","ONE_DAY",days+30); await delay(CFG.RATE_LIMIT_MS);
  const bnD=await fetchCandles("NIFTYBANK","ONE_DAY",days+30); await delay(CFG.RATE_LIMIT_MS);
  const nMap=buildRollingTrend(nD), bnMap=buildRollingTrend(bnD);
  log(`Nifty trend dates:${nMap.size} | BN:${bnMap.size}`);
  const allTrades=[],perSym={},errors=[];
  for (let i=0;i<symbols.length;i++) {
    const sym=symbols[i];
    btRunning.set(id,{done:i,total:symbols.length,currentSymbol:sym,startedAt:new Date().toISOString()});
    log(`[${i+1}/${symbols.length}] ${sym}`);
    const c5=await fetchCandles(sym,"FIVE_MINUTE",days); await delay(CFG.RATE_LIMIT_MS);
    const c15=await fetchCandles(sym,"FIFTEEN_MINUTE",days); await delay(CFG.RATE_LIMIT_MS);
    const cD=await fetchCandles(sym,"ONE_DAY",days); await delay(CFG.RATE_LIMIT_MS);
    if (!c5.length){errors.push(sym);perSym[sym]={error:"no data",trades:0};continue;}
    const trades=simulate(sym,c5,c15,cD,nMap,bnMap,capital);
    allTrades.push(...trades);
    perSym[sym]={candles5m:c5.length,candles15m:c15.length,candlesDaily:cD.length,trades:trades.length,wins:trades.filter(t=>t.netPnL>0).length,grossPnL:+trades.reduce((s,t)=>s+t.grossPnL,0).toFixed(2),netPnL:+trades.reduce((s,t)=>s+t.netPnL,0).toFixed(2)};
    log(`  ${trades.length} trades · net ₹${perSym[sym].netPnL}`);
  }
  const metrics=calcMetrics(allTrades,capital);
  const detTrades=allTrades.map(t=>({
    dateIST:t.entryTimeIST,exitDateIST:t.exitTimeIST,
    symbol:t.symbol,signal:t.signal,
    entryPrice:t.entry,entryTime:t.entryTime,
    exitPrice:t.exit,exitTime:t.exitTime,
    quantity:t.originalQty,sl:t.sl,target:t.target,exitReason:t.exitReason,
    grossPnL:t.grossPnL,netPnL:t.netPnL,charges:t.charges.total,chargesBreakdown:t.charges,
    partialBooked:t.pb||false,partialQty:t.pQty||0,partialPrice:t.pPrice||null,
    partialTimeIST:t.pIST||null,partialGross:t.pGross||0,partialNet:t.pNet||0,
    breakevenTriggered:t.be||false,breakevenPrice:t.bePrice||null,
    confidence:t.confidence,score:t.score,rsi:t.rsi,adx:t.adx,vwap:t.vwap,
    supertrend:t.supertrend,atr:t.atr,volRatio:t.volRatio,pattern:t.pattern,
    macd:t.macd,ema:t.ema,bb:t.bb,
    trend15m:t.trend15m,trendDaily:t.trendDaily,indexTrend:t.indexTrend,
    bullCount:t.bullCount,bearCount:t.bearCount,capital:t.capital,
  }));
  const result={backtestId:id,runDate:new Date().toISOString(),config:{days,symbols,capital,strategy:"v7.1",tradingWindow:"9:30–15:15",orderType:"DELIVERY"},metrics,perSym,errors,trades:detTrades};
  btCache.set(id,result); btRunning.delete(id);
  try{if(!fs.existsSync("./backtests"))fs.mkdirSync("./backtests");fs.writeFileSync(`./backtests/${id}.json`,JSON.stringify(result,null,2));}catch{}
  log(`DONE · ${metrics.total} trades · ${metrics.winRate}% win · ₹${metrics.totalNet} · ${metrics.verdict}`);
}

// ── Endpoints ────────────────────────────────────────────────────────────────
export function addBacktestEndpoints(app,auth) {
  app.post("/api/backtest/run",auth,async(req,res)=>{
    const{days=30,symbols,capital=botState.capital||250000}=req.body;
    const def=["RELIANCE","HDFCBANK","ICICIBANK","INFY","TCS","HINDUNILVR","ITC","BHARTIARTL","SBIN","LT","KOTAKBANK","AXISBANK","BAJFINANCE","ASIANPAINT","MARUTI","SUNPHARMA","TITAN","HCLTECH","NTPC","WIPRO","POWERGRID","TATASTEEL","TECHM","JSWSTEEL","ADANIENT"];
    const symList=Array.isArray(symbols)&&symbols.length?symbols:def;
    const id=`bt-${Date.now()}`;
    res.json({backtestId:id,status:"running",symbols:symList.length,days,capital,estimatedTime:`${Math.ceil(symList.length*3.5/60)}m`});
    runJob(id,symList,days,capital).catch(e=>console.error(`[BT ${id}] Fatal:${e.message}`));
  });

  app.get("/api/backtest/:id",auth,(req,res)=>{
    const r=btCache.get(req.params.id); const ru=btRunning.get(req.params.id);
    if (r) return res.json({status:"completed",...r});
    if (ru) return res.json({status:"running",progress:ru});
    const p=`./backtests/${req.params.id}.json`;
    if (fs.existsSync(p)){try{const r2=JSON.parse(fs.readFileSync(p,"utf8"));btCache.set(req.params.id,r2);return res.json({status:"completed",...r2});}catch{}}
    res.status(404).json({error:"Not found"});
  });

  app.get("/api/backtest/:id/trades",auth,(req,res)=>{
    const result=btCache.get(req.params.id);
    if (!result) return res.status(404).json({error:"Not found"});
    const{page=1,limit=50,symbol,exitReason,signal}=req.query;
    let trades=result.trades||[];
    if (symbol) trades=trades.filter(t=>t.symbol===symbol);
    if (exitReason) trades=trades.filter(t=>t.exitReason===exitReason);
    if (signal) trades=trades.filter(t=>t.signal===signal);
    const total=trades.length, start=(parseInt(page)-1)*parseInt(limit);
    res.json({total,page:parseInt(page),limit:parseInt(limit),pages:Math.ceil(total/parseInt(limit)),trades:trades.slice(start,start+parseInt(limit))});
  });

  app.get("/api/backtest",auth,(req,res)=>{
    try{if(fs.existsSync("./backtests"))fs.readdirSync("./backtests").filter(f=>f.endsWith(".json")).forEach(f=>{const id=f.replace(".json","");if(!btCache.has(id)){try{btCache.set(id,JSON.parse(fs.readFileSync(`./backtests/${f}`,"utf8")));}catch{}}});}catch{}
    const list=[...btCache.entries()].map(([id,r])=>({id,runDate:r.runDate,days:r.config?.days,symbols:r.config?.symbols?.length,capital:r.config?.capital,totalTrades:r.metrics?.total,totalNet:r.metrics?.totalNet,totalGross:r.metrics?.totalGross,totalCharges:r.metrics?.totalCharges,winRate:r.metrics?.winRate,profitFactor:r.metrics?.profitFactor,verdict:r.metrics?.verdict,verdictColor:r.metrics?.verdictColor,returnPct:r.metrics?.returnPct})).sort((a,b)=>new Date(b.runDate)-new Date(a.runDate));
    res.json(list.slice(0,30));
  });

  app.delete("/api/backtest/:id",auth,(req,res)=>{
    btCache.delete(req.params.id);
    try{fs.unlinkSync(`./backtests/${req.params.id}.json`);}catch{}
    res.json({ok:true});
  });
}
