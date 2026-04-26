// ═══════════════════════════════════════════════════════════════════════════
// NSE TradeAI v7.0 · Database Layer + REST API
// ═══════════════════════════════════════════════════════════════════════════
import pg from "pg";
import express from "express";
import cors from "cors";
const { Pool } = pg;

export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

export async function initDB() {
  try {
    await db.query("SELECT NOW()");
    console.log("✅ Database connected");
  } catch (e) {
    console.error("❌ DB connection failed:", e.message);
    throw e;
  }
}

// ═══ WRITE HELPERS ══════════════════════════════════════════════════════════
export async function logSignal(sig, actionTaken = "pending") {
  try {
    await db.query(`
      INSERT INTO signals (
        signal_id, symbol, signal_type, order_type, confidence, score,
        entry, target, stop_loss, quantity, capital_req,
        rsi, adx, vwap, supertrend, pattern, vol_ratio,
        trend_15m, trend_daily, index_trend,
        bull_count, bear_count, safe_to_trade, action_taken
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
      ON CONFLICT (signal_id) DO UPDATE SET action_taken = EXCLUDED.action_taken
    `, [
      sig.id, sig.symbol, sig.signal, sig.orderType,
      sig.confidence, sig.score, sig.entry, sig.target, sig.sl,
      sig.qty, sig.capital,
      sig.indicators?.rsi, sig.indicators?.adx, sig.indicators?.vwap,
      sig.indicators?.supertrend, sig.indicators?.pattern,
      sig.indicators?.volRatio,
      sig.indicators?.trend15m, sig.indicators?.trendDaily,
      sig.indicators?.indexTrend,
      sig.bullCount, sig.bearCount, sig.safeToTrade, actionTaken,
    ]);
  } catch (e) { console.error("logSignal:", e.message); }
}

export async function logTrade(trade) {
  try {
    await db.query(`
      INSERT INTO trades (
        trade_id, signal_id, symbol, mode, side, order_type, broker_order_id,
        entry_price, target, initial_sl, final_sl, quantity, capital_used, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'open')
      RETURNING id
    `, [
      trade.id, trade.signalId || null, trade.symbol, trade.mode,
      trade.signal, trade.orderType, trade.orderId || null,
      trade.entry, trade.target, trade.sl, trade.currentSL,
      trade.qty, trade.capital,
    ]);
  } catch (e) { console.error("logTrade:", e.message); }
}

export async function updateSLMovement(tradeId, oldSL, newSL, price) {
  try {
    await db.query(
      `INSERT INTO sl_movements (trade_id, old_sl, new_sl, price_at_move) VALUES ($1,$2,$3,$4)`,
      [tradeId, oldSL, newSL, price]
    );
    await db.query(
      `UPDATE trades SET final_sl=$1, trail_count=trail_count+1 WHERE trade_id=$2`,
      [newSL, tradeId]
    );
  } catch (e) { console.error("updateSLMovement:", e.message); }
}

export async function closeTrade(tradeId, exitPrice, exitReason, pnl) {
  try {
    await db.query(`
      UPDATE trades SET
        status='closed', exit_price=$2, exit_reason=$3, pnl=$4,
        pnl_pct=ROUND(($4/NULLIF(capital_used,0))*100,2), closed_at=NOW()
      WHERE trade_id=$1
    `, [tradeId, exitPrice, exitReason, pnl]);
  } catch (e) { console.error("closeTrade:", e.message); }
}

export async function logEvent(type, message, metadata = {}) {
  try {
    await db.query(
      `INSERT INTO bot_events (event_type, message, metadata) VALUES ($1,$2,$3)`,
      [type, message, metadata]
    );
  } catch (e) { console.error("logEvent:", e.message); }
}

// ═══ REST API ════════════════════════════════════════════════════════════════
export function startAPI(port = 3000) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

  const AUTH_TOKEN = process.env.MOBILE_AUTH_TOKEN || "change-this-secret";
  const auth = (req, res, next) => {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (token !== AUTH_TOKEN) return res.status(401).json({ error: "Unauthorized" });
    next();
  };

  // ─── DASHBOARD ────────────────────────────────────────────────────────────
  app.get("/api/dashboard", auth, async (req, res) => {
    try {
      const [openTrades, todayStats, signals] = await Promise.all([
        db.query(`SELECT * FROM trades WHERE status='open' ORDER BY opened_at DESC`),
        db.query(`
          SELECT mode, COUNT(*) AS trades, COUNT(*) FILTER(WHERE pnl>0) AS wins,
          SUM(pnl) AS total_pnl FROM trades WHERE status='closed' AND DATE(closed_at)=CURRENT_DATE GROUP BY mode
        `),
        db.query(`SELECT * FROM signals WHERE created_at > NOW()-INTERVAL '2 hours' ORDER BY created_at DESC LIMIT 20`),
      ]);
      res.json({
        openTrades: openTrades.rows,
        today: todayStats.rows,
        recentSignals: signals.rows,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── TRADES ──────────────────────────────────────────────────────────────
  app.get("/api/trades", auth, async (req, res) => {
    const { mode, symbol, from, to, limit = 100 } = req.query;
    let q = `SELECT * FROM trades WHERE status='closed'`;
    const params = [];
    if (mode)   { params.push(mode);   q += ` AND mode=$${params.length}`; }
    if (symbol) { params.push(symbol); q += ` AND symbol=$${params.length}`; }
    if (from)   { params.push(from);   q += ` AND closed_at>=$${params.length}`; }
    if (to)     { params.push(to);     q += ` AND closed_at<=$${params.length}`; }
    q += ` ORDER BY closed_at DESC LIMIT $${params.length+1}`;
    params.push(parseInt(limit));
    try {
      const r = await db.query(q, params);
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── SIGNALS ─────────────────────────────────────────────────────────────
  app.get("/api/signals", auth, async (req, res) => {
    const { limit = 50 } = req.query;
    try {
      const r = await db.query(
        `SELECT * FROM signals ORDER BY created_at DESC LIMIT $1`,
        [parseInt(limit)]
      );
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── ANALYTICS ─────────────────────────────────────────────────────────
  app.get("/api/analytics", auth, async (req, res) => {
    const { days = 30 } = req.query;
    try {
      const daily = await db.query(`
        SELECT DATE(closed_at) AS date, mode,
          COUNT(*) AS trades, COUNT(*) FILTER(WHERE pnl>0) AS wins,
          SUM(pnl) AS total_pnl
        FROM trades WHERE status='closed' AND closed_at>NOW()-INTERVAL '${parseInt(days)} days'
        GROUP BY DATE(closed_at), mode ORDER BY date
      `);
      const bySymbol = await db.query(`
        SELECT symbol, COUNT(*) AS trades, COUNT(*) FILTER(WHERE pnl>0) AS wins,
          SUM(pnl) AS total_pnl, AVG(pnl) AS avg_pnl
        FROM trades WHERE status='closed' AND closed_at>NOW()-INTERVAL '${parseInt(days)} days'
        GROUP BY symbol ORDER BY total_pnl DESC
      `);
      res.json({ daily: daily.rows, bySymbol: bySymbol.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── CONTROL ─────────────────────────────────────────────────────────────
  app.post("/api/control/halt", auth, async (req, res) => {
    await logEvent("HALT", "From mobile");
    res.json({ ok: true });
  });
  app.post("/api/control/resume", auth, async (req, res) => {
    await logEvent("RESUME", "From mobile");
    res.json({ ok: true });
  });

  // ─── EXPORT CSV ──────────────────────────────────────────────────────────
  app.get("/api/export/csv", auth, async (req, res) => {
    try {
      const r = await db.query(`SELECT * FROM trades WHERE status='closed' ORDER BY closed_at DESC`);
      if (!r.rows.length) return res.send("No trades");
      const headers = Object.keys(r.rows[0]).join(",");
      const rows = r.rows.map(row => Object.values(row).map(v => `"${v ?? ""}"`).join(","));
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", "attachment; filename=trades.csv");
      res.send([headers, ...rows].join("\n"));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.listen(port, () => console.log(`📱 API on port ${port}`));
  return { app, auth };
}
