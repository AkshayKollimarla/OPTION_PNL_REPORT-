"""
Auto-calculated fields for the OPTIONS_PNL_REPORT.

`compute_derived(data)` takes the MANUALLY-entered fields and returns a dict of
the 12 derived fields. Used by both the Streamlit app and the CLI entry script
so the formulas live in exactly one place.

Manual (you enter): entry_date, token, investment, options_strike,
    days_to_expiry, opt_entry_qty, opt_entry_price, opt_exit_price, fut_qty,
    fut_entry_price, fut_exit_price, upside_distance, down_distance,
    basket_distance, basket_loss, net_booked_pnl, market_making_pl,
    end_date, status

Derived (auto): expiry, total_theta_gain_loss, per_day_theta_gain_loss,
    total_baskets, total_mm_loss, upside_opt_pnl, down_opt_pnl, upside_fut_pnl,
    downside_fut_pnl, estimated_upside_net_pnl, estimated_downside_net_pnl, apy
"""
import re

DERIVED_FIELDS = [
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
]


def _f(v):
    """Best-effort float (None / blank / bad -> 0.0)."""
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _div(a, b):
    """Safe division (avoid divide-by-zero)."""
    return a / b if b else 0.0


def strike_number(strike):
    """Pull ONLY the numeric part out of a strike string.

    Examples: '96 PUT' -> 96.0, '1700-PE' -> 1700.0, '1,700 PUT' -> 1700.0,
    'PE-1700' -> 1700.0. Always positive (a strike has no sign); thousands
    separators (commas/spaces between digits) are ignored.
    """
    if strike is None:
        return 0.0
    s = str(strike).replace(",", "").replace(" ", "")
    m = re.search(r"\d+(?:\.\d+)?", s)   # first run of digits, no sign
    return float(m.group()) if m else 0.0


def compute_derived(d: dict) -> dict:
    entry_date  = d.get("entry_date")
    expiry      = d.get("expiry")
    # NO. OF DAYS TO EXPIRY = EXPIRY DATE - DATE
    days = (expiry - entry_date).days if (entry_date and expiry) else 0
    opt_qty     = _f(d.get("opt_entry_qty"))
    opt_entry   = _f(d.get("opt_entry_price"))
    opt_exit    = _f(d.get("opt_exit_price"))
    fut_qty     = _f(d.get("fut_qty"))
    fut_entry   = _f(d.get("fut_entry_price"))
    up_dist     = _f(d.get("upside_distance"))
    down_dist   = _f(d.get("down_distance"))
    basket_dist = _f(d.get("basket_distance"))
    basket_loss = _f(d.get("basket_loss"))
    strike      = strike_number(d.get("options_strike"))
    investment  = _f(d.get("investment"))
    mm_pl       = _f(d.get("market_making_pl"))

    out = {}

    # 1) NO. OF DAYS TO EXPIRY = EXPIRY DATE - DATE
    out["days_to_expiry"] = days

    # 2) TOTAL THETA GAIN/LOSS = OPT ENTRY QTY * OPT ENTRY PRICE
    total_theta = opt_qty * opt_entry
    out["total_theta_gain_loss"] = total_theta

    # 3) PER DAY THETA = TOTAL THETA / DAYS TO EXPIRY
    out["per_day_theta_gain_loss"] = _div(total_theta, days)

    # 4) TOTAL BASKETS = DOWNSIDE DISTANCE / BASKET DISTANCE
    total_baskets = _div(down_dist, basket_dist)
    out["total_baskets"] = total_baskets

    # 5) TOTAL MM LOSS  (stored negative = a loss)
    # = (BL*TB) + ((BL/BD) + (BL/BD)/2 + (BL/BD)/2) * (DOWNSIDE DISTANCE / 2)
    blbd = _div(basket_loss, basket_dist)
    mm = (basket_loss * total_baskets) + (blbd + (blbd / 2) + (blbd / 2)) * (down_dist / 2)
    out["total_mm_loss"] = -mm

    # 6) UPSIDE OPT PNL = (OPT EXIT - OPT ENTRY) * OPT ENTRY QTY
    upside_opt = (opt_exit - opt_entry) * opt_qty
    out["upside_opt_pnl"] = upside_opt

    # 7) DOWN OPT PNL = ((STRIKE# - OPT ENTRY) - (FUT ENTRY - DOWN DIST)) * OPT QTY
    down_opt = ((strike - opt_entry) - (fut_entry - down_dist)) * opt_qty
    out["down_opt_pnl"] = down_opt

    # 8) UPSIDE FUT PNL = FUT QTY * UPSIDE DISTANCE
    upside_fut = fut_qty * up_dist
    out["upside_fut_pnl"] = upside_fut

    # 9) DOWNSIDE FUT PNL = -(FUT QTY * DOWNSIDE DISTANCE)   (loss -> negative)
    downside_fut = -(fut_qty * down_dist)
    out["downside_fut_pnl"] = downside_fut

    # 10) EST UPSIDE NET = TOTAL MM LOSS + UPSIDE OPT PNL + UPSIDE FUT PNL
    out["estimated_upside_net_pnl"] = out["total_mm_loss"] + upside_opt + upside_fut

    # 11) EST DOWNSIDE NET = TOTAL MM LOSS + DOWN OPT PNL + DOWNSIDE FUT PNL
    out["estimated_downside_net_pnl"] = out["total_mm_loss"] + down_opt + downside_fut

    # 12) APY = (MARKET MAKING PL / INVESTMENT) * 365 * 100
    out["apy"] = _div(mm_pl, investment) * 365 * 100

    return out
