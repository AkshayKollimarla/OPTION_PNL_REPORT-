"""
Command-line manual entry — prompts only for the MANUAL fields, then
auto-calculates the 12 derived fields and stores everything in MySQL.

Run with:  python enter_trade.py
"""
from datetime import date, datetime

import db
from calculations import compute_derived


def ask(label, cast=str, required=False, default=None):
    while True:
        raw = input(f"{label}{' *' if required else ''}: ").strip()
        if not raw:
            if required:
                print("  -> required, please enter a value")
                continue
            return default
        try:
            if cast is date:
                return datetime.strptime(raw, "%Y-%m-%d").date()
            return cast(raw)
        except ValueError:
            print(f"  -> invalid value, expected {cast.__name__}")


def main():
    db.init_db()
    print("\n=== New strategy — enter MANUAL fields (derived ones auto-calc) ===\n")

    manual = {
        "entry_date": ask("DATE (YYYY-MM-DD)", date, default=date.today()),
        "token": ask("TOKEN (e.g. HOOD)", str, required=True),
        "option_type": (ask("OPTION TYPE (PUT/CALL)", str, default="PUT") or "PUT").upper(),
        "investment": ask("INVESTMENT", float),
        "options_strike": ask("OPTIONS STRIKE (e.g. 96 PUT)", str),
        "expiry": ask("EXPIRY (YYYY-MM-DD)", date),
        "opt_entry_qty": ask("OPT ENTRY QTY", float),
        "opt_entry_price": ask("OPT ENTRY PRICE", float),
        "opt_exit_price": ask("OPT EXIT PRICE", float),
        "fut_qty": ask("FUT QTY", float),
        "fut_entry_price": ask("FUT ENTRY PRICE", float),
        "fut_exit_price": ask("FUT EXIT PRICE", float),
        "upside_distance": ask("UPSIDE DISTANCE", float),
        "down_distance": ask("DOWN DISTANCE", float),
        "basket_distance": ask("BASKET DISTANCE", float),
        "basket_loss": ask("BASKET LOSS", float),
        "net_booked_pnl": ask("NET BOOKED PNL", float),
        "market_making_pl": ask("MARKET MAKING PL", float),
        "end_date": ask("END DATE (YYYY-MM-DD)", date),
        "status": (ask("STATUS (open/closed)", str, default="open") or "open").lower(),
    }

    derived = compute_derived(manual)
    row = {**manual, **derived}

    print("\n--- Auto-calculated ---")
    for k, v in derived.items():
        print(f"  {k}: {v}")

    new_id = db.insert_trade(row)
    print(f"\n✓ Saved strategy #{new_id} into the database.\n")


if __name__ == "__main__":
    main()
