# Options PnL Report

A Streamlit + MySQL app to log a futures + options basket / market-making
strategy, auto-calculate the derived fields live, store everything in MySQL,
and analyse strategies after they close.

## Features
- **Add Strategy** — enter the manual fields; the 12 derived fields auto-fill live.
- **Dashboard** — view all strategies, summary metrics, CSV export.
- **Update / Close** — edit exit prices / booked PnL; derived fields recompute.
- **Analysis** — detailed view of a closed strategy.

## Project files
| File | Purpose |
|------|---------|
| `app.py` | Streamlit UI (4 tabs) |
| `db.py` | MySQL connection, schema, CRUD |
| `calculations.py` | All auto-calc formulas (one place) |
| `enter_trade.py` | Command-line manual entry |
| `migrate.py` | Drop + recreate the table with the current schema |
| `config.example.py` | Config template → copy to `config.py` |

## Setup

### 1. Install
```bash
pip install -r requirements.txt
```

### 2. Configure MySQL
Copy the template and add your credentials (this file is git-ignored):
```bash
cp config.example.py config.py     # Windows: copy config.example.py config.py
```
Then edit `config.py` and set your MySQL `password` (and host/user if different).
You can also override via env vars: `DB_HOST DB_PORT DB_USER DB_PASSWORD DB_NAME`.

### 3. Create the database + table
```bash
python db.py
```
Creates database `options_pnl_report` and table `options_trades` if missing.
(Use `python migrate.py` to drop and recreate the table — deletes existing rows.)

### 4. Run
```bash
streamlit run app.py        # web app
python enter_trade.py       # or command-line entry
```

## Auto-calculated formulas
| Field | Formula |
|------|---------|
| NO OF DAYS TO EXPIRY | EXPIRY − DATE |
| TOTAL THETA GAIN/LOSS | OPT ENTRY QTY × OPT ENTRY PRICE |
| PER DAY THETA GAIN/LOSS | TOTAL THETA ÷ DAYS TO EXPIRY |
| TOTAL BASKETS | DOWNSIDE DISTANCE ÷ BASKET DISTANCE |
| TOTAL MM LOSS | (BL×TB) + ((BL/BD) + (BL/BD)/2 + (BL/BD)/2) × (DOWN DIST/2), stored negative |
| UPSIDE OPT PNL | (OPT EXIT − OPT ENTRY) × OPT QTY |
| DOWN OPT PNL | ((STRIKE# − OPT ENTRY) − (FUT ENTRY − DOWN DIST)) × OPT QTY |
| UPSIDE FUT PNL | FUT QTY × UPSIDE DISTANCE |
| DOWNSIDE FUT PNL | −(FUT QTY × DOWNSIDE DISTANCE) |
| EST UPSIDE NET PNL | TOTAL MM LOSS + UPSIDE OPT PNL + UPSIDE FUT PNL |
| EST DOWNSIDE NET PNL | TOTAL MM LOSS + DOWN OPT PNL + DOWNSIDE FUT PNL |
| APY | (MARKET MAKING PL ÷ INVESTMENT) × 365 × 100 |

> Strike is entered as free text (e.g. `1700-PE`); only the numeric part is used in formulas.
