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

import pandas as pd
import streamlit as st

import db
from calculations import compute_derived, DERIVED_FIELDS, strike_number
from config import DB_NAME, TABLE_NAME

st.set_page_config(page_title="Options PnL Report", layout="wide")

# Make disabled (auto-calculated) fields show their value in dark, bold text
# instead of the faint default grey.
st.markdown(
    """
    <style>
    input:disabled {
        -webkit-text-fill-color: #0e1117 !important;
        color: #0e1117 !important;
        opacity: 1 !important;
        font-weight: 700 !important;
    }
    div[data-testid="stNumberInput"] > div:has(input:disabled),
    div[data-testid="stTextInput"] > div:has(input:disabled) {
        opacity: 1 !important;
    }
    </style>
    """,
    unsafe_allow_html=True,
)

try:
    db.init_db()
except Exception as e:  # noqa: BLE001
    st.error(f"Could not connect to MySQL. Check config.py / env vars.\n\n{e}")
    st.stop()

st.title("📊 Options PnL Report")
st.caption(f"Database: `{DB_NAME}` · Table: `{TABLE_NAME}`")

H = {
    "entry_date": "Date the strategy was entered/opened.",
    "token": "Underlying token/symbol (e.g. HOOD, BTC, NIFTY).",
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
        "entry_date": entry_date, "token": token, "investment": investment,
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

    st.markdown("##### 🔒 Auto-calculated (auto-filled)")

    st.markdown("**General / Theta**")
    g1, g2, g3, g4, g5 = st.columns(5)
    g1.number_input("NO OF DAYS TO EXPIRY", value=int(derived["days_to_expiry"]), disabled=True, help=help_("days_to_expiry"))
    g2.number_input("TOTAL THETA GAIN/LOSS", value=float(derived["total_theta_gain_loss"]), disabled=True, format="%.4f", help=help_("total_theta_gain_loss"))
    g3.number_input("PER DAY THETA GAIN/LOSS", value=float(derived["per_day_theta_gain_loss"]), disabled=True, format="%.4f", help=help_("per_day_theta_gain_loss"))
    g4.number_input("TOTAL BASKETS", value=float(derived["total_baskets"]), disabled=True, format="%.4f", help=help_("total_baskets"))
    g5.number_input("TOTAL MM LOSS", value=float(derived["total_mm_loss"]), disabled=True, format="%.4f", help=help_("total_mm_loss"))

    st.markdown("**📈 Upside**")
    u1, u2, u3 = st.columns(3)
    u1.number_input("UPSIDE OPT PNL", value=float(derived["upside_opt_pnl"]), disabled=True, format="%.4f", help=help_("upside_opt_pnl"))
    u2.number_input("UPSIDE FUT PNL", value=float(derived["upside_fut_pnl"]), disabled=True, format="%.4f", help=help_("upside_fut_pnl"))
    u3.number_input("EST UPSIDE NET PNL", value=float(derived["estimated_upside_net_pnl"]), disabled=True, format="%.4f", help=help_("estimated_upside_net_pnl"))

    st.markdown("**📉 Downside**")
    o1, o2, o3 = st.columns(3)
    o1.number_input("DOWN OPT PNL", value=float(derived["down_opt_pnl"]), disabled=True, format="%.4f", help=help_("down_opt_pnl"))
    o2.number_input("DOWNSIDE FUT PNL", value=float(derived["downside_fut_pnl"]), disabled=True, format="%.4f", help=help_("downside_fut_pnl"))
    o3.number_input("EST DOWNSIDE NET PNL", value=float(derived["estimated_downside_net_pnl"]), disabled=True, format="%.4f", help=help_("estimated_downside_net_pnl"))

    st.markdown("**Return**")
    st.number_input("APY", value=float(derived["apy"]), disabled=True, format="%.4f", help=help_("apy"))

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
            end_date = st.date_input("END DATE", value=t["end_date"] or date.today(), key="up_enddate", help=help_("end_date"))
            status = st.selectbox("STATUS", ["open", "closed"], key="up_status",
                                  index=0 if t["status"] == "open" else 1, help=help_("status"))

        # merge existing row with edits, then recompute every derived field
        merged = {**t,
                  "opt_exit_price": opt_exit_price, "fut_exit_price": fut_exit_price,
                  "net_booked_pnl": net_booked_pnl, "market_making_pl": market_making_pl,
                  "end_date": end_date, "status": status}
        recomputed = compute_derived(merged)

        st.markdown("##### 🔒 Recalculated (auto-filled)")
        r1, r2, r3 = st.columns(3)
        with r1:
            st.number_input("UPSIDE OPT PNL ", value=float(recomputed["upside_opt_pnl"]), disabled=True, format="%.4f")
            st.number_input("DOWN OPT PNL ", value=float(recomputed["down_opt_pnl"]), disabled=True, format="%.4f")
        with r2:
            st.number_input("EST UPSIDE NET PNL ", value=float(recomputed["estimated_upside_net_pnl"]), disabled=True, format="%.4f")
            st.number_input("EST DOWNSIDE NET PNL ", value=float(recomputed["estimated_downside_net_pnl"]), disabled=True, format="%.4f")
        with r3:
            st.number_input("APY ", value=float(recomputed["apy"]), disabled=True, format="%.4f")

        if st.button("💾 Save changes", type="primary"):
            update = {
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
