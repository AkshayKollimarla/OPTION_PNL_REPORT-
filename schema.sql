-- Trading Bot Analytics — MySQL schema
-- Run this once (or use `npm run db:init`) to create the database and table.

CREATE DATABASE IF NOT EXISTS trading_dashboard
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE trading_dashboard;

CREATE TABLE IF NOT EXISTS bot_entries (
  id                   INT AUTO_INCREMENT PRIMARY KEY,

  -- Header / token
  entry_datetime       DATETIME      NOT NULL,
  token_name           VARCHAR(50)   NOT NULL,
  token_symbol         VARCHAR(50)   DEFAULT NULL,
  account              VARCHAR(100)  DEFAULT NULL,

  -- Top metric cards
  rtps                 DECIMAL(20,4) DEFAULT 0,
  rtp_pnl              DECIMAL(20,4) DEFAULT 0,
  per_hour_rtps        DECIMAL(20,4) DEFAULT 0,
  rebates              DECIMAL(20,4) DEFAULT 0,
  gamma_booked         DECIMAL(20,4) DEFAULT 0,
  flatten_pnl          DECIMAL(20,4) DEFAULT 0,
  net_pnl              DECIMAL(20,4) DEFAULT 0,
  volume               DECIMAL(20,4) DEFAULT 0,
  apy                  DECIMAL(10,4) DEFAULT 0,

  -- Bot details (left column)
  investment           DECIMAL(20,4) DEFAULT 0,
  entry_futures        DECIMAL(20,4) DEFAULT 0,
  entry_futures_price  DECIMAL(20,4) DEFAULT 0,
  bot_entry_price      DECIMAL(20,4) DEFAULT 0,
  market_making_qty    DECIMAL(20,4) DEFAULT 0,
  average_spread       DECIMAL(10,4) DEFAULT 0,
  target_spread        DECIMAL(10,4) DEFAULT 0,
  basket_distance      DECIMAL(10,4) DEFAULT 0,
  total_distance       DECIMAL(10,4) DEFAULT 0,

  -- Bot details (right column)
  total_steps          INT           DEFAULT 0,
  per_step_qty         DECIMAL(20,4) DEFAULT 0,
  rtp_value            DECIMAL(20,4) DEFAULT 0,
  total_baskets_one_side INT         DEFAULT 0,
  basket_loss          DECIMAL(20,4) DEFAULT 0,
  total_baskets        INT           DEFAULT 0,
  daily_loss           DECIMAL(20,4) DEFAULT 0,
  basket_max_qty       DECIMAL(20,4) DEFAULT 0,
  upper_limit          DECIMAL(20,4) DEFAULT 0,
  lower_limit          DECIMAL(20,4) DEFAULT 0,

  created_at           TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_token (token_name),
  INDEX idx_datetime (entry_datetime)
);
