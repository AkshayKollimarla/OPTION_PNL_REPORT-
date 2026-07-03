// Ported from options_pnl_app/calculations.py

function _f(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0.0 : n;
}

function _div(a, b) {
  return b === 0 ? 0.0 : a / b;
}

export function strikeNumber(strike) {
  if (!strike) return 0.0;
  const m = String(strike).replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : 0.0;
}

export const DERIVED_FIELDS = [
  "days_to_expiry",
  "total_theta_gain_loss",
  "per_day_theta_gain_loss",
  "total_baskets",
  "total_mm_loss",
  "upside_opt_pnl",
  "down_opt_pnl",
  "upside_fut_pnl",
  "downside_fut_pnl",
  "estimated_upside_net_pnl",
  "estimated_downside_net_pnl",
  "apy",
];

export function computeDerived(d) {
  // When entry_date is blank, fall back to today so the expiry countdown
  // still shows a useful number in the live preview.
  const entryDate = d.entry_date ? new Date(d.entry_date) : new Date();
  const expiry    = d.expiry     ? new Date(d.expiry)     : null;

  let days_to_expiry = 0;
  if (expiry && !isNaN(entryDate) && !isNaN(expiry)) {
    days_to_expiry = Math.round((expiry - entryDate) / 86400000);
  }

  const opt_entry_qty   = _f(d.opt_entry_qty);
  const opt_entry_price = _f(d.opt_entry_price);
  const opt_exit_price  = _f(d.opt_exit_price);
  const fut_qty         = _f(d.fut_qty);
  const fut_entry_price = _f(d.fut_entry_price);
  const upside_distance = _f(d.upside_distance);
  const down_distance   = _f(d.down_distance);
  const basket_distance = _f(d.basket_distance);
  const basket_loss     = _f(d.basket_loss);
  const market_making_pl = _f(d.market_making_pl);
  const investment      = _f(d.investment);
  const option_type     = (d.option_type || "PUT").toUpperCase();
  const strike_num      = strikeNumber(d.options_strike);

  const total_theta_gain_loss    = opt_entry_qty * opt_entry_price;
  const per_day_theta_gain_loss  = _div(total_theta_gain_loss, days_to_expiry);
  const total_baskets            = _div(down_distance, basket_distance);

  // total_mm_loss — stored negative (a loss)
  const blbd        = _div(basket_loss, basket_distance);
  const mm          = (basket_loss * total_baskets) + (blbd + blbd / 2 + blbd / 2) * (down_distance / 2);
  const total_mm_loss = -mm;

  // Limits (auto-derived from futures price + distances)
  const upper_limit = fut_entry_price + upside_distance;
  const lower_limit = fut_entry_price - down_distance;

  // Option PnL formulas (qty sign distinguishes LONG vs SHORT automatically)
  //
  // CALL (LONG qty > 0 / SHORT qty < 0):
  //   Upside: IF (strike + entry_price) > upper_limit → -(entry_price × qty)
  //           ELSE (upper_limit − (strike + entry_price)) × qty
  //   Downside: entry_price × (−qty)
  //
  // PUT (LONG qty > 0 / SHORT qty < 0):
  //   Downside: IF (strike − entry_price) < lower_limit → -(entry_price × qty)
  //             ELSE ((strike − entry_price) − lower_limit) × qty
  //   Upside: entry_price × (−qty)

  let upside_opt_pnl, down_opt_pnl;
  if (option_type === "CALL") {
    const breakeven = strike_num + opt_entry_price;
    upside_opt_pnl = breakeven > upper_limit
      ? -(opt_entry_price * opt_entry_qty)
      : (upper_limit - breakeven) * opt_entry_qty;
    down_opt_pnl = opt_entry_price * (-opt_entry_qty);
  } else { // PUT
    const net_strike = strike_num - opt_entry_price;
    down_opt_pnl = net_strike < lower_limit
      ? -(opt_entry_price * opt_entry_qty)
      : (net_strike - lower_limit) * opt_entry_qty;
    upside_opt_pnl = opt_entry_price * (-opt_entry_qty);
  }

  const upside_fut_pnl             = fut_qty * upside_distance;
  const downside_fut_pnl           = -(fut_qty * down_distance);
  const estimated_upside_net_pnl   = total_mm_loss + upside_opt_pnl + upside_fut_pnl;
  const estimated_downside_net_pnl = total_mm_loss + down_opt_pnl + downside_fut_pnl;
  const apy                        = investment ? (market_making_pl / investment) * 365 * 100 : 0;

  return {
    days_to_expiry,
    total_theta_gain_loss,
    per_day_theta_gain_loss,
    total_baskets,
    total_mm_loss,
    upper_limit,
    lower_limit,
    upside_opt_pnl,
    down_opt_pnl,
    upside_fut_pnl,
    downside_fut_pnl,
    estimated_upside_net_pnl,
    estimated_downside_net_pnl,
    apy,
  };
}
