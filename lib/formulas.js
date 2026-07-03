// ─────────────────────────────────────────────────────────────────────────────
// FIELD FORMULAS  — defined in dependency order so later formulas can read
// values computed by earlier ones in the same pass.
// f = current form snapshot (all values are strings — Number() coerces safely)
// Return "" to leave a field blank when inputs are missing/zero.
// ─────────────────────────────────────────────────────────────────────────────

const n = (v) => Number(v) || 0;

export const FORMULAS = {

  // ── depends on raw inputs only ───────────────────────────────────────────

  // 6. Total Steps = Basket Distance(%) / Average Spread(%)
  total_steps: (f) => {
    const avgSpread = n(f.average_spread);
    if (!avgSpread) return "";
    return n(f.basket_distance) / avgSpread;
  },

  // 7. RTP Value = Per Step Qty × Target Spread(%)
  rtp_value: (f) => n(f.per_step_qty) * n(f.target_spread),

  // ── depends on total_steps (computed above) ───────────────────────────────

  // 5. Market Making Qty = Total Steps × Per Step Qty
  market_making_qty: (f) => n(f.total_steps) * n(f.per_step_qty),

  // ── depends on rtp_value (computed above) ────────────────────────────────

  // 1. RTPS = RTP-PNL / RTP Value
  rtps: (f) => {
    const rtpVal = n(f.rtp_value);
    if (!rtpVal) return "";
    return n(f.rtp_pnl) / rtpVal;
  },

  // ── depends on rtps (computed above) ─────────────────────────────────────

  // 2. Per Hour RTPS = RTPS / 24
  per_hour_rtps: (f) => {
    const rtps = n(f.rtps);
    if (!rtps) return "";
    return rtps / 24;
  },

  // ── depends on raw inputs only ───────────────────────────────────────────

  // 3. Net-PNL = RTP-PNL + Gamma Booked + Rebates  (Flatten tracked separately, not in Net PNL)
  net_pnl: (f) =>
    n(f.rtp_pnl) + n(f.gamma_booked) + n(f.rebates),

  // 8. Total Baskets One Side = (Total Distance / Basket Distance) - 1
  total_baskets_one_side: (f) => {
    const bd = n(f.basket_distance);
    if (!bd) return "";
    return n(f.total_distance) / bd - 1;
  },

  // 10. Total Baskets = Total Distance(%) / Basket Distance(%)
  total_baskets: (f) => {
    const bd = n(f.basket_distance);
    if (!bd) return "";
    return n(f.total_distance) / bd;
  },

  // 13. Upper Limit = Bot Entry Price + Total Distance(%)
  upper_limit: (f) => n(f.bot_entry_price) + n(f.total_distance),

  // 14. Lower Limit = Bot Entry Price - Total Distance(%)
  lower_limit: (f) => n(f.bot_entry_price) - n(f.total_distance),

  // ── depends on market_making_qty (computed above) ─────────────────────────

  // 9. Basket Loss = Market Making Qty × (Basket Distance(%) / 2)
  basket_loss: (f) => n(f.market_making_qty) * (n(f.basket_distance) / 2),

  // 12. Basket Max Qty = Market Making Qty
  basket_max_qty: (f) => n(f.market_making_qty),

  // ── depends on net_pnl (computed above) ──────────────────────────────────

  // 4. APY(%) = (Net-PNL / Investment) × 365 × 100
  apy: (f) => {
    const investment = n(f.investment);
    if (!investment) return "";
    return (n(f.net_pnl) / investment) * 365 * 100;
  },

  // ── depends on total_baskets + basket_loss (both computed above) ──────────

  // 11. Daily Loss = Total Baskets × Basket Loss
  daily_loss: (f) => n(f.total_baskets) * n(f.basket_loss),
};
