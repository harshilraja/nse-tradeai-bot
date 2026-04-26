-- NSE TradeAI v7.0 · Database Schema

CREATE TABLE IF NOT EXISTS signals (
  id          SERIAL PRIMARY KEY,
  signal_id   VARCHAR(100) UNIQUE,
  symbol      VARCHAR(20),
  signal_type VARCHAR(10),
  order_type  VARCHAR(20),
  confidence  DECIMAL(5,2),
  score       DECIMAL(8,3),
  entry       DECIMAL(12,2),
  target      DECIMAL(12,2),
  stop_loss   DECIMAL(12,2),
  quantity    INTEGER,
  capital_req DECIMAL(14,2),
  rsi         DECIMAL(6,2),
  adx         DECIMAL(6,2),
  vwap        DECIMAL(12,2),
  supertrend  VARCHAR(10),
  pattern     VARCHAR(30),
  vol_ratio   DECIMAL(6,2),
  trend_15m   VARCHAR(15),
  trend_daily VARCHAR(15),
  index_trend VARCHAR(15),
  bull_count  INTEGER,
  bear_count  INTEGER,
  safe_to_trade BOOLEAN,
  action_taken VARCHAR(20) DEFAULT 'pending',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trades (
  id              SERIAL PRIMARY KEY,
  trade_id        VARCHAR(100) UNIQUE,
  signal_id       VARCHAR(100),
  symbol          VARCHAR(20),
  mode            VARCHAR(10),
  side            VARCHAR(5),
  order_type      VARCHAR(20),
  broker_order_id VARCHAR(50),
  entry_price     DECIMAL(12,2),
  exit_price      DECIMAL(12,2),
  target          DECIMAL(12,2),
  initial_sl      DECIMAL(12,2),
  final_sl        DECIMAL(12,2),
  quantity        INTEGER,
  original_qty    INTEGER,
  capital_used    DECIMAL(14,2),
  status          VARCHAR(10) DEFAULT 'open',
  pnl             DECIMAL(14,2),
  pnl_pct         DECIMAL(8,2),
  exit_reason     VARCHAR(30),
  trail_count     INTEGER DEFAULT 0,
  breakeven_triggered BOOLEAN DEFAULT FALSE,
  partial_booked  BOOLEAN DEFAULT FALSE,
  partial_pnl     DECIMAL(12,2),
  opened_at       TIMESTAMPTZ DEFAULT NOW(),
  closed_at       TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sl_movements (
  id          SERIAL PRIMARY KEY,
  trade_id    VARCHAR(100),
  old_sl      DECIMAL(12,2),
  new_sl      DECIMAL(12,2),
  price_at_move DECIMAL(12,2),
  moved_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bot_events (
  id          SERIAL PRIMARY KEY,
  event_type  VARCHAR(30),
  message     TEXT,
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bot_config (
  key         VARCHAR(50) PRIMARY KEY,
  value       TEXT,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Seed config
INSERT INTO bot_config (key, value) VALUES
  ('is_halted', 'false'),
  ('live_trading', 'false')
ON CONFLICT (key) DO NOTHING;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol);
CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at);
CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_closed ON trades(closed_at);

-- Views
CREATE OR REPLACE VIEW v_open_trades AS
  SELECT * FROM trades WHERE status='open';

CREATE OR REPLACE VIEW v_today_trades AS
  SELECT * FROM trades WHERE status='closed' AND DATE(closed_at)=CURRENT_DATE;

CREATE OR REPLACE VIEW v_performance AS
  SELECT
    mode,
    COUNT(*) AS total_trades,
    COUNT(*) FILTER(WHERE pnl>0) AS wins,
    ROUND(100.0*COUNT(*) FILTER(WHERE pnl>0)/NULLIF(COUNT(*),0),2) AS win_rate,
    SUM(pnl) AS total_pnl,
    AVG(pnl) AS avg_pnl
  FROM trades WHERE status='closed'
  GROUP BY mode;
