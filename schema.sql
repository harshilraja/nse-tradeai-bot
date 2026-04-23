-- ═══════════════════════════════════════════════════════════════════════════
-- NSE TradeAI Bot · Database Schema (PostgreSQL)
-- Run this once on Railway Postgres to create all tables
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── SIGNALS: every signal generated, even if not executed ─────────────────
CREATE TABLE IF NOT EXISTS signals (
  id              SERIAL PRIMARY KEY,
  signal_id       VARCHAR(64) UNIQUE NOT NULL,
  symbol          VARCHAR(32) NOT NULL,
  signal_type     VARCHAR(8) NOT NULL,        -- BUY / SELL / HOLD
  order_type      VARCHAR(8),                 -- MIS / CNC
  confidence      DECIMAL(5,2),
  score           DECIMAL(5,2),
  entry           DECIMAL(10,2),
  target          DECIMAL(10,2),
  stop_loss       DECIMAL(10,2),
  quantity        INTEGER,
  capital_req     DECIMAL(12,2),
  rsi             DECIMAL(5,2),
  macd_bullish    BOOLEAN,
  ema_trend       VARCHAR(12),
  vol_ratio       DECIMAL(5,2),
  bull_count      INTEGER,
  bear_count      INTEGER,
  safe_to_trade   BOOLEAN,
  action_taken    VARCHAR(16),                -- executed_live / executed_paper / skipped / expired
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_signals_symbol ON signals(symbol);
CREATE INDEX idx_signals_created ON signals(created_at DESC);
CREATE INDEX idx_signals_action ON signals(action_taken);

-- ─── TRADES: every executed trade (paper or live) ──────────────────────────
CREATE TABLE IF NOT EXISTS trades (
  id              SERIAL PRIMARY KEY,
  trade_id        VARCHAR(64) UNIQUE NOT NULL,
  signal_id       VARCHAR(64) REFERENCES signals(signal_id),
  symbol          VARCHAR(32) NOT NULL,
  mode            VARCHAR(8) NOT NULL,        -- live / paper
  side            VARCHAR(8) NOT NULL,        -- BUY / SELL
  order_type      VARCHAR(8),                 -- MIS / CNC
  broker_order_id VARCHAR(64),
  entry_price     DECIMAL(10,2) NOT NULL,
  exit_price      DECIMAL(10,2),
  target          DECIMAL(10,2),
  initial_sl      DECIMAL(10,2),
  final_sl        DECIMAL(10,2),
  quantity        INTEGER NOT NULL,
  capital_used    DECIMAL(12,2),
  status          VARCHAR(16) DEFAULT 'open', -- open / closed
  exit_reason     VARCHAR(32),                -- TARGET_HIT / SL_HIT / MANUAL / EOD_SQUARE_OFF
  pnl             DECIMAL(12,2),
  pnl_pct         DECIMAL(6,2),
  max_profit      DECIMAL(12,2),              -- peak unrealized profit
  max_drawdown    DECIMAL(12,2),              -- max unrealized loss
  trail_count     INTEGER DEFAULT 0,          -- how many times SL was trailed up
  opened_at       TIMESTAMP DEFAULT NOW(),
  closed_at       TIMESTAMP
);

CREATE INDEX idx_trades_symbol ON trades(symbol);
CREATE INDEX idx_trades_opened ON trades(opened_at DESC);
CREATE INDEX idx_trades_mode ON trades(mode);
CREATE INDEX idx_trades_status ON trades(status);

-- ─── SL MOVEMENTS: every trailing SL change per trade ──────────────────────
CREATE TABLE IF NOT EXISTS sl_movements (
  id              SERIAL PRIMARY KEY,
  trade_id        VARCHAR(64) REFERENCES trades(trade_id) ON DELETE CASCADE,
  old_sl          DECIMAL(10,2),
  new_sl          DECIMAL(10,2),
  price_at_move   DECIMAL(10,2),
  moved_at        TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_sl_trade ON sl_movements(trade_id);

-- ─── DAILY STATS: cached daily performance ─────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_stats (
  id                SERIAL PRIMARY KEY,
  date              DATE UNIQUE NOT NULL,
  mode              VARCHAR(8) NOT NULL,      -- live / paper
  trades_taken      INTEGER DEFAULT 0,
  trades_won        INTEGER DEFAULT 0,
  trades_lost       INTEGER DEFAULT 0,
  total_pnl         DECIMAL(12,2) DEFAULT 0,
  win_rate          DECIMAL(5,2),
  avg_win           DECIMAL(12,2),
  avg_loss          DECIMAL(12,2),
  best_trade        DECIMAL(12,2),
  worst_trade       DECIMAL(12,2),
  capital_deployed  DECIMAL(12,2),
  updated_at        TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_daily_date ON daily_stats(date DESC);
CREATE UNIQUE INDEX idx_daily_date_mode ON daily_stats(date, mode);

-- ─── BOT EVENTS: audit log ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bot_events (
  id              SERIAL PRIMARY KEY,
  event_type      VARCHAR(32) NOT NULL,       -- STARTUP / HALT / RESUME / LOSS_CAP_HIT / ERROR
  message         TEXT,
  metadata        JSONB,
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_events_created ON bot_events(created_at DESC);
CREATE INDEX idx_events_type ON bot_events(event_type);

-- ─── USER CONFIG: runtime-adjustable settings ──────────────────────────────
CREATE TABLE IF NOT EXISTS bot_config (
  key             VARCHAR(64) PRIMARY KEY,
  value           TEXT,
  updated_at      TIMESTAMP DEFAULT NOW()
);

INSERT INTO bot_config (key, value) VALUES
  ('risk_per_trade', '1000'),
  ('daily_loss_cap', '2500'),
  ('max_positions',  '3'),
  ('live_trading',   'false'),
  ('is_halted',      'false')
ON CONFLICT (key) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════
-- HELPER VIEWS
-- ═══════════════════════════════════════════════════════════════════════════

-- Live performance summary
CREATE OR REPLACE VIEW v_performance AS
SELECT
  mode,
  COUNT(*)                                  AS total_trades,
  COUNT(*) FILTER (WHERE pnl > 0)           AS wins,
  COUNT(*) FILTER (WHERE pnl < 0)           AS losses,
  ROUND(100.0 * COUNT(*) FILTER (WHERE pnl > 0) / NULLIF(COUNT(*), 0), 2) AS win_rate,
  SUM(pnl)                                  AS total_pnl,
  AVG(pnl) FILTER (WHERE pnl > 0)           AS avg_win,
  AVG(pnl) FILTER (WHERE pnl < 0)           AS avg_loss,
  MAX(pnl)                                  AS best_trade,
  MIN(pnl)                                  AS worst_trade
FROM trades
WHERE status = 'closed'
GROUP BY mode;

-- Open positions
CREATE OR REPLACE VIEW v_open_trades AS
SELECT t.*,
       NOW() - t.opened_at AS duration
FROM trades t
WHERE t.status = 'open'
ORDER BY t.opened_at DESC;
