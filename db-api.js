// ═══════════════════════════════════════════════════════════════════════════
// NSE TradeAI · Database Layer + REST API
// PostgreSQL persistence + Express API for mobile app
// ═══════════════════════════════════════════════════════════════════════════

import pg from "pg";
import express from "express";
import cors from "cors";

const { Pool } = pg;

// ═══ DATABASE CONNECTION POOL ══════════════════════════════════════════════
export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

export async function initDB() {
  try {
    await db.query("SELECT NOW()");
    console.log("✅ Database connected");
  } catch (e) {
    console.error("❌ Database connection failed:", e.message);
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DATABASE WRITE HELPERS
// ═══════════════════════════════════════════════════════════════════════════

export async function logSignal(sig, actionTaken = "pending") {
  try {
    const q = `
      INSERT INTO signals (
        signal_id, symbol, signal_type, order_type, confidence, score,
        entry, target, stop_loss, quantity, capital_req,
        rsi, macd_bullish, ema_trend, vol_ratio, bull_count, bear_count,
        safe_to_trade, action_taken
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      ON CONFLICT (signal_id) DO UPDATE SET action_taken = EXCLUDED.action_taken
    `;
    await db.query(q, [
      sig.id, sig.symbol, sig.signal, sig.orderType, sig.confidence, sig.score,
      sig.entry, sig.target, sig.sl, sig.qty, sig.capital,
      sig.indicators.rsi, sig.indicators.checks.macd === "bull", sig.indicators.checks.ema, sig.indicators.volRatio,
      sig.bullCount, sig.bearCount, sig.safeToTrade, actionTaken,
    ]);
  } catch (e) {
    console.error("logSignal error:", e.message);
  }
}

export async function logTrade(trade) {
  try {
    const q = `
      INSERT INTO trades (
        trade_id, signal_id, symbol, mode, side, order_type, broker_order_id,
        entry_price, target, initial_sl, final_sl, quantity, capital_used, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'open')
      RETURNING id
    `;
    const r = await db.query(q, [
      trade.id, trade.signalId || null, trade.symbol, trade.mode, trade.signal,
      trade.orderType, trade.orderId || null,
      trade.entry, trade.target, trade.sl, trade.currentSL, trade.qty, trade.capital,
    ]);
    return r.rows[0]?.id;
  } catch (e) {
    console.error("logTrade error:", e.message);
  }
}

export async function updateSLMovement(tradeId, oldSL, newSL, priceAtMove) {
  try {
    await db.query(
      `INSERT INTO sl_movements (trade_id, old_sl, new_sl, price_at_move) VALUES ($1,$2,$3,$4)`,
      [tradeId, oldSL, newSL, priceAtMove]
    );
    await db.query(
      `UPDATE trades SET final_sl = $1, trail_count = trail_count + 1 WHERE trade_id = $2`,
      [newSL, tradeId]
    );
  } catch (e) {
    console.error("updateSLMovement error:", e.message);
  }
}

export async function closeTrade(tradeId, exitPrice, exitReason, pnl) {
  try {
    const q = `
      UPDATE trades SET
        status = 'closed',
        exit_price = $2,
        exit_reason = $3,
        pnl = $4,
        pnl_pct = ROUND(($4 / NULLIF(capital_used, 0)) * 100, 2),
        closed_at = NOW()
      WHERE trade_id = $1
    `;
    await db.query(q, [tradeId, exitPrice, exitReason, pnl]);
    await updateDailyStats();
  } catch (e) {
    console.error("closeTrade error:", e.message);
  }
}

export async function updateDailyStats() {
  try {
    const q = `
      INSERT INTO daily_stats (date, mode, trades_taken, trades_won, trades_lost, total_pnl, win_rate, avg_win, avg_loss, best_trade, worst_trade, capital_deployed)
      SELECT
        CURRENT_DATE, mode,
        COUNT(*), COUNT(*) FILTER (WHERE pnl > 0), COUNT(*) FILTER (WHERE pnl < 0),
        COALESCE(SUM(pnl), 0),
        ROUND(100.0 * COUNT(*) FILTER (WHERE pnl > 0) / NULLIF(COUNT(*), 0), 2),
        AVG(pnl) FILTER (WHERE pnl > 0),
        AVG(pnl) FILTER (WHERE pnl < 0),
        MAX(pnl), MIN(pnl), SUM(capital_used)
      FROM trades
      WHERE status = 'closed' AND DATE(closed_at) = CURRENT_DATE
      GROUP BY mode
      ON CONFLICT (date, mode) DO UPDATE SET
        trades_taken = EXCLUDED.trades_taken,
        trades_won = EXCLUDED.trades_won,
        trades_lost = EXCLUDED.trades_lost,
        total_pnl = EXCLUDED.total_pnl,
        win_rate = EXCLUDED.win_rate,
        avg_win = EXCLUDED.avg_win,
        avg_loss = EXCLUDED.avg_loss,
        best_trade = EXCLUDED.best_trade,
        worst_trade = EXCLUDED.worst_trade,
        capital_deployed = EXCLUDED.capital_deployed,
        updated_at = NOW()
    `;
    await db.query(q);
  } catch (e) {
    console.error("updateDailyStats error:", e.message);
  }
}

export async function logEvent(type, message, metadata = {}) {
  try {
    await db.query(
      `INSERT INTO bot_events (event_type, message, metadata) VALUES ($1,$2,$3)`,
      [type, message, metadata]
    );
  } catch (e) {
    console.error("logEvent error:", e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// REST API SERVER
// ═══════════════════════════════════════════════════════════════════════════
export function startAPI(port = 3000) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Health check (no auth)
  app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

  // Auth middleware
  const AUTH_TOKEN = process.env.MOBILE_AUTH_TOKEN || "change-this-secret";
  const auth = (req, res, next) => {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (token !== AUTH_TOKEN) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  };

  // ─── DASHBOARD ───────────────────────────────────────────────────────────
  app.get("/api/dashboard", auth, async (req, res) => {
    try {
      const [openTrades, todayStats, totalStats, recentSignals] = await Promise.all([
        db.query(`SELECT * FROM v_open_trades`),
        db.query(`SELECT * FROM daily_stats WHERE date = CURRENT_DATE`),
        db.query(`SELECT * FROM v_performance`),
        db.query(`SELECT * FROM signals WHERE created_at > NOW() - INTERVAL '1 hour' ORDER BY created_at DESC LIMIT 10`),
      ]);
      res.json({
        openTrades: openTrades.rows,
        today: todayStats.rows,
        overall: totalStats.rows,
        recentSignals: recentSignals.rows,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── TRADES ──────────────────────────────────────────────────────────────
  app.get("/api/trades", auth, async (req, res) => {
    const { mode, symbol, from, to, limit = 100 } = req.query;
    let query = `SELECT * FROM trades WHERE status = 'closed'`;
    const params = [];
    if (mode)   { params.push(mode);   query += ` AND mode = $${params.length}`; }
    if (symbol) { params.push(symbol); query += ` AND symbol = $${params.length}`; }
    if (from)   { params.push(from);   query += ` AND closed_at >= $${params.length}`; }
    if (to)     { params.push(to);     query += ` AND closed_at <= $${params.length}`; }
    query += ` ORDER BY closed_at DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit));
    try {
      const r = await db.query(query, params);
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── SINGLE TRADE ─────────────────────────────────────────────────────────
  app.get("/api/trades/:id", auth, async (req, res) => {
    try {
      const trade = await db.query(`SELECT * FROM trades WHERE trade_id = $1`, [req.params.id]);
      const slMoves = await db.query(`SELECT * FROM sl_movements WHERE trade_id = $1 ORDER BY moved_at`, [req.params.id]);
      res.json({ trade: trade.rows[0], slMovements: slMoves.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── ANALYTICS ────────────────────────────────────────────────────────────
  app.get("/api/analytics", auth, async (req, res) => {
    const { days = 30 } = req.query;
    try {
      const daily = await db.query(
        `SELECT * FROM daily_stats WHERE date > CURRENT_DATE - INTERVAL '${parseInt(days)} days' ORDER BY date`
      );
      const bySymbol = await db.query(`
        SELECT symbol,
          COUNT(*) as trades,
          COUNT(*) FILTER (WHERE pnl > 0) as wins,
          ROUND(100.0 * COUNT(*) FILTER (WHERE pnl > 0) / NULLIF(COUNT(*), 0), 2) as win_rate,
          SUM(pnl) as total_pnl
        FROM trades WHERE status='closed' AND closed_at > NOW() - INTERVAL '${parseInt(days)} days'
        GROUP BY symbol ORDER BY total_pnl DESC
      `);
      const byHour = await db.query(`
        SELECT EXTRACT(HOUR FROM opened_at) as hour,
          COUNT(*) as trades,
          AVG(pnl) as avg_pnl,
          SUM(pnl) as total_pnl
        FROM trades WHERE status='closed' AND closed_at > NOW() - INTERVAL '${parseInt(days)} days'
        GROUP BY hour ORDER BY hour
      `);
      res.json({ daily: daily.rows, bySymbol: bySymbol.rows, byHour: byHour.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── SIGNALS ─────────────────────────────────────────────────────────────
  app.get("/api/signals", auth, async (req, res) => {
    const { limit = 50, action } = req.query;
    let query = `SELECT * FROM signals`;
    const params = [];
    if (action) { params.push(action); query += ` WHERE action_taken = $${params.length}`; }
    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit));
    try {
      const r = await db.query(query, params);
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── BOT CONTROL ─────────────────────────────────────────────────────────
  app.post("/api/control/halt", auth, async (req, res) => {
    await db.query(`UPDATE bot_config SET value = 'true', updated_at = NOW() WHERE key = 'is_halted'`);
    await logEvent("HALT", "Bot halted from mobile");
    res.json({ ok: true });
  });

  app.post("/api/control/resume", auth, async (req, res) => {
    await db.query(`UPDATE bot_config SET value = 'false', updated_at = NOW() WHERE key = 'is_halted'`);
    await logEvent("RESUME", "Bot resumed from mobile");
    res.json({ ok: true });
  });

  app.post("/api/control/config", auth, async (req, res) => {
    const { key, value } = req.body;
    await db.query(`UPDATE bot_config SET value = $1, updated_at = NOW() WHERE key = $2`, [value, key]);
    await logEvent("CONFIG_CHANGE", `${key} = ${value}`, { key, value });
    res.json({ ok: true });
  });

  app.get("/api/config", auth, async (req, res) => {
    const r = await db.query(`SELECT * FROM bot_config`);
    const cfg = {};
    r.rows.forEach(row => cfg[row.key] = row.value);
    res.json(cfg);
  });

  // ─── EXPORT CSV ──────────────────────────────────────────────────────────
  app.get("/api/export/csv", auth, async (req, res) => {
    try {
      const r = await db.query(`SELECT * FROM trades WHERE status='closed' ORDER BY closed_at DESC`);
      if (r.rows.length === 0) return res.send("No trades yet");
      const headers = Object.keys(r.rows[0]).join(",");
      const rows = r.rows.map(row => Object.values(row).map(v => `"${v || ""}"`).join(","));
      const csv = [headers, ...rows].join("\n");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", "attachment; filename=trades.csv");
      res.send(csv);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.listen(port, () => console.log(`📱 Mobile API running on port ${port}`));
  
  // Return app and auth so they can be extended by other modules
  return { app, auth };
}
