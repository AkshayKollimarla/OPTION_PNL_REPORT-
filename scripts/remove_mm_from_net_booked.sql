-- Take market-making out of the stored booked result.
--
-- net_booked_pnl used to be stored as fut_pnl + opt_pnl + market_making_pl.
-- It is now fut_pnl + opt_pnl, because market-making is the grid bot's own
-- contribution and is reported on the bot side from the entry log; counting it
-- in the options total meant it appeared twice in every combined figure.
--
-- market_making_pl itself is deliberately NOT cleared. It stays as the record
-- of what each strategy booked on the bot side, and it is what makes this
-- reversible: re-adding it restores the previous totals exactly.
--
-- Run against the options_pnl_report database. Take a dump first.

-- 1. What the change will do (run this on its own first).
SELECT COUNT(*)                                                          AS rows_total,
       SUM(market_making_pl IS NOT NULL AND market_making_pl <> 0)       AS rows_affected,
       ROUND(SUM(COALESCE(net_booked_pnl, 0)), 2)                        AS net_before,
       ROUND(SUM(COALESCE(market_making_pl, 0)), 2)                      AS mm_removed,
       ROUND(SUM(COALESCE(net_booked_pnl, 0) - COALESCE(market_making_pl, 0)), 2) AS net_after
  FROM options_trades;

-- 2. The change itself.
UPDATE options_trades
   SET net_booked_pnl = COALESCE(net_booked_pnl, 0) - market_making_pl
 WHERE market_making_pl IS NOT NULL
   AND market_making_pl <> 0;

-- 3. Verification: every row that recorded the split must now satisfy
--    net_booked_pnl = fut_pnl + opt_pnl. Expect 0.
SELECT SUM(ABS(COALESCE(net_booked_pnl, 0)
               - (COALESCE(fut_pnl, 0) + COALESCE(opt_pnl, 0))) > 0.01) AS mismatches
  FROM options_trades
 WHERE fut_pnl IS NOT NULL AND opt_pnl IS NOT NULL;

-- To undo (only if nothing has been edited since):
--   UPDATE options_trades
--      SET net_booked_pnl = COALESCE(net_booked_pnl, 0) + market_making_pl
--    WHERE market_making_pl IS NOT NULL AND market_making_pl <> 0;
