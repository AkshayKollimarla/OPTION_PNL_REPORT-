"""
Options PnL Report — Streamlit app (futures + options basket strategy).

Tabs:
  1. Add Strategy   -> manual fields + LIVE auto-calculated fields -> MySQL
  2. Dashboard      -> view all rows, metrics, CSV export
  3. Update / Close -> edit exit prices / booked PnL; derived fields recompute
  4. Analysis       -> detailed view of a closed strategy

Run with:  streamlit run app.py
"""
from datetime import date
import math
import os

import pandas as pd
import streamlit as st

import db
from calculations import compute_derived, DERIVED_FIELDS, strike_number
from config import DB_NAME, TABLE_NAME


def _pinwheel(color="#ffffff", blades=8, swirl=38):
    """Build the String Metaverse swirl/alloy-wheel logo as SVG inner shapes."""
    cx = cy = 50
    inner, outer = 14, 46
    parts = []
    for i in range(blades):
        a0 = math.radians(i * 360 / blades)
        pts = []
        for s in range(13):
            t = s / 12
            r = inner + (outer - inner) * t
            ang = a0 + math.radians(swirl) * t
            pts.append((cx + r * math.cos(ang), cy + r * math.sin(ang)))
        d = "M " + " L ".join(f"{x:.1f},{y:.1f}" for x, y in pts)
        parts.append(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="3.4" '
                     'stroke-linecap="round" stroke-linejoin="round"/>')
        ex, ey = pts[-1]
        parts.append(f'<circle cx="{ex:.1f}" cy="{ey:.1f}" r="5.0" fill="{color}"/>')
    parts.append(f'<circle cx="{cx}" cy="{cy}" r="3.2" fill="{color}"/>')
    return "".join(parts)


def logo_svg(color="#ffffff", size=44):
    return (f'<svg viewBox="0 0 100 100" width="{size}" height="{size}" '
            f'xmlns="http://www.w3.org/2000/svg">{_pinwheel(color)}</svg>')


_FAVICON = os.path.join(os.path.dirname(os.path.abspath(__file__)), "favicon.png")
st.set_page_config(
    page_title="StringMetaverse Options Strategy Logs",
    page_icon=_FAVICON if os.path.exists(_FAVICON) else "📊",
    layout="wide",
)

# ---- Dark / Light toggle ----
if "dark_mode" not in st.session_state:
    st.session_state["dark_mode"] = True
_sp, _tg = st.columns([6, 1])
with _tg:
    st.toggle("🌙 Dark mode", key="dark_mode")
DARK = st.session_state["dark_mode"]

# ---- Theme palette (String Metaverse orange accent) ----
if DARK:
    C = dict(bg="#0B0F14", surface="#121824", border="#1E2A3A",
             text="#C9D1D9", muted="#8B98A5", head="#F4F7FB", hover="#2C3E54",
             ibrd="#1E2A3A", itext="#C9D1D9")
    PROFIT, LOSS = "#2ECC71", "#FF4D4F"
else:
    C = dict(bg="#F5F7FA", surface="#FFFFFF", border="#D7DEE8",
             text="#0B1320", muted="#5B6675", head="#0B1320", hover="#9AA7B8",
             ibrd="#B4BECC", itext="#000000")
    PROFIT, LOSS = "#1FA463", "#E5484D"
ACCENT = "#F4631E"        # String Metaverse orange
ACCENT_2 = "#FF8A3D"

# ---- Theme-aware styling ----
st.markdown(
    "<style>:root {"
    f" --bg:{C['bg']}; --surface:{C['surface']}; --border:{C['border']};"
    f" --accent:{ACCENT}; --accent2:{ACCENT_2}; --profit:{PROFIT}; --loss:{LOSS};"
    f" --neutral:{C['text']}; --muted:{C['muted']}; --head:{C['head']}; --hover:{C['hover']};"
    f" --ibrd:{C['ibrd']}; --itext:{C['itext']};"
    " }</style>",
    unsafe_allow_html=True,
)

st.markdown(
    """
    <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600;700&display=swap');

    .stApp { background-color: var(--bg); color: var(--neutral); font-family: 'Inter', sans-serif; }
    [data-testid="stHeader"] { background: transparent; }
    .block-container { padding-top: 2.2rem; max-width: 1500px; }

    /* Typography hierarchy */
    h1 { font-size: 24px !important; font-weight: 600 !important; color: var(--head) !important; letter-spacing:-0.01em; }
    h2, h3 { font-size: 16px !important; font-weight: 600 !important; color: var(--head) !important; }
    h4, h5 { font-size: 14px !important; font-weight: 500 !important; color: var(--neutral) !important;
             text-transform: uppercase; letter-spacing: 0.06em; }
    .stApp, p, span, label, li { font-size: 13px; }
    [data-testid="stCaptionContainer"] { color: var(--muted) !important; font-size: 12px; }

    /* Inputs — ONE clean border on every widget's outer container */
    [data-testid="stTextInput"] > div,
    [data-testid="stNumberInput"] > div,
    [data-testid="stDateInput"] > div,
    [data-testid="stSelectbox"] > div {
        background: var(--surface) !important;
        border: 1px solid var(--ibrd) !important;
        border-radius: 8px !important;
        box-shadow: none !important;
    }
    /* strip ALL inner baseweb borders/shadows so there's exactly one outline */
    [data-testid="stTextInput"] div[data-baseweb="input"],
    [data-testid="stTextInput"] div[data-baseweb="base-input"],
    [data-testid="stNumberInput"] div[data-baseweb="input"],
    [data-testid="stNumberInput"] div[data-baseweb="base-input"],
    [data-testid="stDateInput"] div[data-baseweb="input"],
    [data-testid="stDateInput"] div[data-baseweb="base-input"],
    [data-testid="stSelectbox"] div[data-baseweb="select"] > div {
        background: transparent !important;
        border: none !important;
        box-shadow: none !important;
    }
    /* inner text styling */
    .stTextInput input, .stNumberInput input, .stDateInput input,
    .stSelectbox div[data-baseweb="select"] span {
        color: var(--itext) !important;
        font-family: 'JetBrains Mono', monospace !important; font-weight: 600 !important;
        -webkit-text-fill-color: var(--itext) !important;
    }
    /* focus state -> accent border, never red */
    [data-testid="stTextInput"] > div:focus-within,
    [data-testid="stNumberInput"] > div:focus-within,
    [data-testid="stDateInput"] > div:focus-within,
    [data-testid="stSelectbox"] > div:focus-within {
        border-color: var(--accent) !important;
    }
    .stTextInput label, .stNumberInput label, .stDateInput label, .stSelectbox label {
        color: var(--muted) !important; font-size: 11px !important; font-weight: 500 !important;
        text-transform: uppercase; letter-spacing: 0.05em;
    }
    /* hide the +/- steppers on number inputs */
    [data-testid="stNumberInputStepUp"],
    [data-testid="stNumberInputStepDown"] { display: none !important; }
    input:disabled { -webkit-text-fill-color: var(--neutral) !important; color: var(--neutral) !important; opacity: 1 !important; }

    /* Tabs */
    .stTabs [data-baseweb="tab-list"] { gap: 6px; border-bottom: 1px solid var(--border); }
    .stTabs [data-baseweb="tab"] { color: var(--muted); font-weight: 500; font-size: 13px; }
    .stTabs [aria-selected="true"] { color: var(--accent) !important; }
    .stTabs [data-baseweb="tab-highlight"] { background-color: var(--accent); }

    /* Buttons */
    .stButton > button {
        background: var(--accent); color: #08111C; border: none; border-radius: 8px;
        font-weight: 600; font-size: 13px; padding: 0.5rem 1.1rem;
    }
    .stButton > button:hover { filter: brightness(1.08); color: #08111C; }

    /* Native metrics (dashboard) */
    [data-testid="stMetric"] { background: var(--surface); border: 1px solid var(--border);
        border-radius: 10px; padding: 14px 16px; }
    [data-testid="stMetricValue"] { font-family: 'JetBrains Mono', monospace; font-weight: 700; color: var(--head); }
    [data-testid="stMetricLabel"] { color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }

    /* Dataframe */
    [data-testid="stDataFrame"] { border: 1px solid var(--border); border-radius: 10px; }

    /* Info banner */
    [data-testid="stAlert"] { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; }

    /* Custom stat cards (auto-calculated values) */
    .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
        gap: 12px; margin: 6px 0 14px; }
    .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
        padding: 13px 16px; transition: border-color .15s ease; }
    .stat-card:hover { border-color: var(--hover); }
    .stat-label { color: var(--muted); font-size: 11px; font-weight: 500; letter-spacing: 0.05em;
        text-transform: uppercase; margin-bottom: 7px; }
    .stat-value { font-family: 'JetBrains Mono', monospace; font-size: 20px; font-weight: 700; line-height: 1.1; }
    .group-head { font-size: 12px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
        color: var(--muted); margin: 6px 0 2px; }

    /* String Metaverse brand banner */
    .brand-banner {
        background: linear-gradient(120deg, #E8531B 0%, #F4631E 45%, #FF8A3D 100%);
        border-radius: 14px; padding: 22px 28px; margin: 4px 0 18px;
        display: flex; flex-direction: column; align-items: center; gap: 6px;
        box-shadow: 0 6px 24px rgba(244, 99, 30, 0.25);
    }
    .brand-row { display: flex; align-items: center; gap: 12px; }
    .brand-word { color: #fff; font-family: 'Inter', sans-serif; font-weight: 700;
        letter-spacing: 0.22em; font-size: 14px; }
    .brand-title {
        font-family: Calibri, 'Segoe UI', 'Inter', sans-serif;
        font-weight: 700; font-size: 30px; color: #ffffff; text-align: center;
        letter-spacing: 0.5px; line-height: 1.15; margin: 2px 0;
        text-shadow: 0 1px 2px rgba(0,0,0,0.18);
    }
    .brand-sub { color: rgba(255,255,255,0.92); font-family: 'Inter', sans-serif;
        font-size: 12px; letter-spacing: 0.16em; text-transform: uppercase; }
    </style>
    """,
    unsafe_allow_html=True,
)


def stat_cards(items):
    """Render a grid of premium stat cards.

    items: list of (label, value, kind) where kind is
      'neutral' (default text), 'pnl' (green/red by sign), or 'accent' (blue).
    """
    cells = []
    for label, value, kind in items:
        if kind == "pnl":
            color = "var(--profit)" if (value or 0) >= 0 else "var(--loss)"
        elif kind == "accent":
            color = "var(--accent)"
        else:
            color = "var(--head)"
        if isinstance(value, int):
            text = f"{value:,}"
        elif isinstance(value, float):
            text = f"{value:,.2f}"
        else:
            text = str(value)
        cells.append(
            f'<div class="stat-card"><div class="stat-label">{label}</div>'
            f'<div class="stat-value" style="color:{color}">{text}</div></div>'
        )
    st.markdown(f'<div class="stat-grid">{"".join(cells)}</div>', unsafe_allow_html=True)

try:
    db.init_db()
except Exception as e:  # noqa: BLE001
    st.error(f"Could not connect to MySQL. Check config.py / env vars.\n\n{e}")
    st.stop()

st.markdown(
    f"""
    <div class="brand-banner">
        <div class="brand-row">{logo_svg("#ffffff", 44)}<span class="brand-word">STRING METAVERSE</span></div>
        <div class="brand-title">STRINGMETAVERSE OPTIONS STRATEGY LOGS</div>
        <div class="brand-sub">A Web 3.0 Enterprise</div>
    </div>
    """,
    unsafe_allow_html=True,
)

H = {
    "entry_date": "Date the strategy was entered/opened.",
    "token": "Underlying token/symbol (e.g. HOOD, BTC, NIFTY).",
    "option_type": "PUT or CALL — changes the UPSIDE OPT PNL & DOWN OPT PNL formulas.",
    "investment": "Total capital deployed in the strategy.",
    "options_strike": "Option strike traded — free text, e.g. '96 PUT'.",
    "expiry": "Option expiry date (you enter this).",
    "days_to_expiry": "AUTO = expiry date − entry date.",
    "total_theta_gain_loss": "AUTO = opt entry qty × opt entry price.",
    "per_day_theta_gain_loss": "AUTO = total theta ÷ days to expiry.",
    "opt_entry_qty": "Option quantity entered.",
    "opt_entry_price": "Option price at entry (premium per unit).",
    "opt_exit_price": "Option price at exit (0 if expired worthless).",
    "fut_qty": "Futures quantity used to hedge / market-make.",
    "fut_entry_price": "Futures price at entry.",
    "fut_exit_price": "Futures price at exit.",
    "upside_distance": "Distance to the upside breakeven/target.",
    "down_distance": "Distance to the downside breakeven/target.",
    "basket_distance": "Price gap between each basket/ladder order.",
    "total_baskets": "AUTO = downside distance ÷ basket distance.",
    "basket_loss": "Loss per basket if it fills against you.",
    "total_mm_loss": "AUTO from basket loss / baskets / distances (stored as a loss).",
    "upside_opt_pnl": "AUTO = (opt exit − opt entry) × opt qty.",
    "down_opt_pnl": "AUTO = ((strike# − opt entry) − (fut entry − down dist)) × opt qty.",
    "upside_fut_pnl": "AUTO = fut qty × upside distance.",
    "downside_fut_pnl": "AUTO = −(fut qty × downside distance).",
    "estimated_upside_net_pnl": "AUTO = total mm loss + upside opt pnl + upside fut pnl.",
    "estimated_downside_net_pnl": "AUTO = total mm loss + down opt pnl + downside fut pnl.",
    "net_booked_pnl": "Actual net PnL booked when the strategy was closed.",
    "market_making_pl": "Profit/loss from market-making activity (drives APY).",
    "apy": "AUTO = (market making PL ÷ investment) × 365 × 100.",
    "end_date": "Date the strategy was closed/exited.",
    "status": "open = still running · closed = exited and booked.",
}


def help_(key):
    return "❗ " + H[key]


st.info("Fields marked 🔒 are **auto-calculated** and update live as you type the inputs.")

tab_add, tab_dash, tab_close, tab_analysis = st.tabs(
    ["➕ Add Strategy", "📋 Dashboard", "✏️ Update / Close", "🔍 Analysis"]
)


def fmt(v):
    return f"{v:,.2f}" if isinstance(v, (int, float)) else ("" if v is None else str(v))


# --------------------------------------------------------------------------- #
# 1. ADD STRATEGY  (live auto-calc, no st.form)
# --------------------------------------------------------------------------- #
with tab_add:
    st.subheader("Enter a new strategy")
    st.caption("Hover the ❗ / ⓘ icon for each field's meaning. 🔒 = auto-calculated.")

    st.markdown("##### Inputs")
    c1, c2, c3 = st.columns(3)
    with c1:
        entry_date = st.date_input("DATE *", value=date.today(), help=help_("entry_date"))
        token = st.text_input("TOKEN *", placeholder="e.g. HOOD", help=help_("token"))
        option_type = st.selectbox("OPTION TYPE *", ["PUT", "CALL"], help=help_("option_type"))
        investment = st.number_input("INVESTMENT", value=0.0, format="%.4f", help=help_("investment"))
        options_strike = st.text_input("OPTIONS STRIKE", placeholder="e.g. 96 PUT", help=help_("options_strike"))
        st.caption(f"Parsed strike number used in formulas: **{strike_number(options_strike)}**")
        expiry = st.date_input("EXPIRY *", value=date.today(), help=help_("expiry"))
        opt_entry_qty = st.number_input("OPT ENTRY QTY", value=0.0, format="%.4f", help=help_("opt_entry_qty"))
    with c2:
        opt_entry_price = st.number_input("OPT ENTRY PRICE", value=0.0, format="%.4f", help=help_("opt_entry_price"))
        opt_exit_price = st.number_input("OPT EXIT PRICE", value=0.0, format="%.4f", help=help_("opt_exit_price"))
        fut_qty = st.number_input("FUT QTY", value=0.0, format="%.4f", help=help_("fut_qty"))
        fut_entry_price = st.number_input("FUT ENTRY PRICE", value=0.0, format="%.4f", help=help_("fut_entry_price"))
        fut_exit_price = st.number_input("FUT EXIT PRICE", value=0.0, format="%.4f", help=help_("fut_exit_price"))
        upside_distance = st.number_input("UPSIDE DISTANCE", value=0.0, format="%.4f", help=help_("upside_distance"))
    with c3:
        down_distance = st.number_input("DOWN DISTANCE", value=0.0, format="%.4f", help=help_("down_distance"))
        basket_distance = st.number_input("BASKET DISTANCE", value=0.0, format="%.4f", help=help_("basket_distance"))
        basket_loss = st.number_input("BASKET LOSS", value=0.0, format="%.4f", help=help_("basket_loss"))
        net_booked_pnl = st.number_input("NET BOOKED PNL", value=0.0, format="%.4f", help=help_("net_booked_pnl"))
        market_making_pl = st.number_input("MARKET MAKING PL", value=0.0, format="%.4f", help=help_("market_making_pl"))
        end_date = st.date_input("END DATE", value=None, help=help_("end_date"))
        status = st.selectbox("STATUS", ["open", "closed"], help=help_("status"))

    # assemble manual inputs and compute derived live
    manual = {
        "entry_date": entry_date, "token": token, "option_type": option_type,
        "investment": investment,
        "options_strike": options_strike, "expiry": expiry,
        "opt_entry_qty": opt_entry_qty, "opt_entry_price": opt_entry_price,
        "opt_exit_price": opt_exit_price, "fut_qty": fut_qty,
        "fut_entry_price": fut_entry_price, "fut_exit_price": fut_exit_price,
        "upside_distance": upside_distance, "down_distance": down_distance,
        "basket_distance": basket_distance, "basket_loss": basket_loss,
        "net_booked_pnl": net_booked_pnl, "market_making_pl": market_making_pl,
        "end_date": end_date, "status": status,
    }
    derived = compute_derived(manual)

    st.markdown("##### 🔒 Auto-calculated")

    st.markdown('<div class="group-head">General / Theta</div>', unsafe_allow_html=True)
    stat_cards([
        ("NO OF DAYS TO EXPIRY", int(derived["days_to_expiry"]), "neutral"),
        ("TOTAL THETA GAIN/LOSS", float(derived["total_theta_gain_loss"]), "pnl"),
        ("PER DAY THETA GAIN/LOSS", float(derived["per_day_theta_gain_loss"]), "pnl"),
        ("TOTAL BASKETS", float(derived["total_baskets"]), "neutral"),
        ("TOTAL MM LOSS", float(derived["total_mm_loss"]), "pnl"),
    ])

    st.markdown('<div class="group-head">📈 Upside</div>', unsafe_allow_html=True)
    stat_cards([
        ("UPSIDE OPT PNL", float(derived["upside_opt_pnl"]), "pnl"),
        ("UPSIDE FUT PNL", float(derived["upside_fut_pnl"]), "pnl"),
        ("EST UPSIDE NET PNL", float(derived["estimated_upside_net_pnl"]), "pnl"),
    ])

    st.markdown('<div class="group-head">📉 Downside</div>', unsafe_allow_html=True)
    stat_cards([
        ("DOWN OPT PNL", float(derived["down_opt_pnl"]), "pnl"),
        ("DOWNSIDE FUT PNL", float(derived["downside_fut_pnl"]), "pnl"),
        ("EST DOWNSIDE NET PNL", float(derived["estimated_downside_net_pnl"]), "pnl"),
    ])

    st.markdown('<div class="group-head">Return</div>', unsafe_allow_html=True)
    stat_cards([("APY", float(derived["apy"]), "accent")])

    if st.button("💾 Save strategy", type="primary"):
        if not token.strip():
            st.warning("TOKEN is required.")
        else:
            row = {**manual, **derived}
            row["token"] = token.strip()
            row["options_strike"] = options_strike.strip() or None
            new_id = db.insert_trade(row)
            st.success(f"Saved strategy #{new_id} (inputs + auto-calculated fields) ✓")

# --------------------------------------------------------------------------- #
# 2. DASHBOARD
# --------------------------------------------------------------------------- #
with tab_dash:
    st.subheader("Strategies")
    view = st.radio("Show", ["All", "open", "closed"], horizontal=True)
    rows = db.fetch_trades(None if view == "All" else view)

    if not rows:
        st.info("No strategies yet. Add one in the **Add Strategy** tab.")
    else:
        df = pd.DataFrame(rows)
        closed = df[df["status"] == "closed"]
        m1, m2, m3, m4 = st.columns(4)
        m1.metric("Total", len(df))
        m2.metric("Open", int((df["status"] == "open").sum()))
        m3.metric("Closed", len(closed))
        if not closed.empty:
            total = pd.to_numeric(closed["net_booked_pnl"], errors="coerce").sum()
            m4.metric("Net booked PnL (closed)", f"{total:,.2f}")

        st.dataframe(df, use_container_width=True, hide_index=True)
        st.download_button(
            "⬇️ Download CSV",
            df.to_csv(index=False).encode("utf-8"),
            "options_pnl_report.csv", "text/csv",
        )

        # ---- Delete a strategy ----
        st.markdown("---")
        st.markdown("##### 🗑️ Delete a strategy")
        del_labels = {
            r["id"]: f'#{r["id"]} · {r["token"]} · {r["options_strike"] or ""} '
                     f'· {r["entry_date"]} · {r["status"]}'
            for r in rows
        }
        dc1, dc2 = st.columns([3, 1])
        with dc1:
            del_id = st.selectbox(
                "Select strategy to delete", list(del_labels),
                format_func=lambda i: del_labels[i], key="del_select",
            )
        with dc2:
            confirm_del = st.checkbox("Confirm", key="del_confirm",
                                      help="Tick to enable the delete button.")
        if st.button("Delete permanently", type="primary", disabled=not confirm_del):
            db.delete_trade(del_id)
            st.success(f"Deleted strategy #{del_id} ✓")
            st.rerun()

# --------------------------------------------------------------------------- #
# 3. UPDATE / CLOSE  (recomputes derived fields after edit)
# --------------------------------------------------------------------------- #
with tab_close:
    st.subheader("Update exit prices / booked PnL and close")
    all_rows = db.fetch_trades(None)
    if not all_rows:
        st.info("No strategies yet.")
    else:
        labels = {
            r["id"]: f'#{r["id"]} · {r["token"]} · {r["options_strike"] or ""} '
                     f'· {r["entry_date"]} · {r["status"]}'
            for r in all_rows
        }
        cid = st.selectbox("Select strategy", list(labels), format_func=lambda i: labels[i])
        t = next(r for r in all_rows if r["id"] == cid)

        def f(v):
            return float(v) if v is not None else 0.0

        u1, u2, u3 = st.columns(3)
        with u1:
            opt_exit_price = st.number_input("OPT EXIT PRICE", value=f(t["opt_exit_price"]), format="%.4f", key="up_optexit", help=help_("opt_exit_price"))
            fut_exit_price = st.number_input("FUT EXIT PRICE", value=f(t["fut_exit_price"]), format="%.4f", key="up_futexit", help=help_("fut_exit_price"))
        with u2:
            net_booked_pnl = st.number_input("NET BOOKED PNL", value=f(t["net_booked_pnl"]), format="%.4f", key="up_booked", help=help_("net_booked_pnl"))
            market_making_pl = st.number_input("MARKET MAKING PL", value=f(t["market_making_pl"]), format="%.4f", key="up_mmpl", help=help_("market_making_pl"))
        with u3:
            option_type = st.selectbox("OPTION TYPE", ["PUT", "CALL"], key="up_opttype",
                                       index=0 if str(t.get("option_type", "PUT")).upper() != "CALL" else 1,
                                       help=help_("option_type"))
            end_date = st.date_input("END DATE", value=t["end_date"] or date.today(), key="up_enddate", help=help_("end_date"))
            status = st.selectbox("STATUS", ["open", "closed"], key="up_status",
                                  index=0 if t["status"] == "open" else 1, help=help_("status"))

        # merge existing row with edits, then recompute every derived field
        merged = {**t,
                  "option_type": option_type,
                  "opt_exit_price": opt_exit_price, "fut_exit_price": fut_exit_price,
                  "net_booked_pnl": net_booked_pnl, "market_making_pl": market_making_pl,
                  "end_date": end_date, "status": status}
        recomputed = compute_derived(merged)

        st.markdown("##### 🔒 Recalculated")
        stat_cards([
            ("UPSIDE OPT PNL", float(recomputed["upside_opt_pnl"]), "pnl"),
            ("DOWN OPT PNL", float(recomputed["down_opt_pnl"]), "pnl"),
            ("EST UPSIDE NET PNL", float(recomputed["estimated_upside_net_pnl"]), "pnl"),
            ("EST DOWNSIDE NET PNL", float(recomputed["estimated_downside_net_pnl"]), "pnl"),
            ("APY", float(recomputed["apy"]), "accent"),
        ])

        if st.button("💾 Save changes", type="primary"):
            update = {
                "option_type": option_type,
                "opt_exit_price": opt_exit_price, "fut_exit_price": fut_exit_price,
                "net_booked_pnl": net_booked_pnl, "market_making_pl": market_making_pl,
                "end_date": end_date, "status": status,
                **{k: recomputed[k] for k in DERIVED_FIELDS},
            }
            db.update_trade(cid, update)
            st.success(f"Strategy #{cid} updated and recalculated ✓")
            st.rerun()

# --------------------------------------------------------------------------- #
# 4. ANALYSIS (closed strategies)
# --------------------------------------------------------------------------- #
with tab_analysis:
    st.subheader("Detailed analysis — closed strategies")
    closed_rows = db.fetch_trades("closed")
    if not closed_rows:
        st.info("No closed strategies yet.")
    else:
        labels = {r["id"]: f'#{r["id"]} · {r["token"]} · {r["options_strike"] or ""}' for r in closed_rows}
        cid = st.selectbox("Select closed strategy", list(labels), format_func=lambda i: labels[i])
        t = next(r for r in closed_rows if r["id"] == cid)

        def f(v):
            return float(v) if v is not None else 0.0

        net = f(t["net_booked_pnl"])
        inv = f(t["investment"])
        ret_pct = (net / inv * 100) if inv else 0.0

        st.markdown(f"### {t['token']} · {t['options_strike'] or ''}")
        m1, m2, m3, m4 = st.columns(4)
        m1.metric("Net booked PnL", f"{net:,.2f}")
        m2.metric("Return on investment", f"{ret_pct:,.2f}%")
        m3.metric("Market making PL", f"{f(t['market_making_pl']):,.2f}")
        m4.metric("APY", f"{f(t['apy']):,.2f}%")

        st.markdown("#### Estimated vs booked")
        e1, e2, e3 = st.columns(3)
        e1.metric("Est. upside net PnL", f"{f(t['estimated_upside_net_pnl']):,.2f}")
        e2.metric("Est. downside net PnL", f"{f(t['estimated_downside_net_pnl']):,.2f}")
        e3.metric("Booked − est. upside", f"{net - f(t['estimated_upside_net_pnl']):,.2f}")

        st.markdown("#### Full record")
        st.dataframe(pd.DataFrame([t]).T.rename(columns={0: "value"}), use_container_width=True)
