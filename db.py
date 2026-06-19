"""
Database layer: connection, schema creation, and CRUD helpers.

Schema matches the OPTIONS_PNL_REPORT sheet (futures + options basket /
market-making strategy). One row per strategy. Exit/booked fields stay NULL
until the strategy is closed.
"""
import mysql.connector
from mysql.connector import errorcode

from config import DB_CONFIG, DB_NAME, TABLE_NAME

# Column order matches the sheet. `entry_date` maps to the sheet's "DATE"
# (DATE is a reserved word, so we store it as a clean column name).
COLUMNS = [
    "entry_date",                  # DATE
    "token",                       # TOKEN
    "option_type",                 # PUT / CALL
    "investment",                  # INVESTMENT
    "options_strike",             # OPTIONS STRIKE  (text, e.g. "96 PUT")
    "expiry",                      # EXPIRY
    "days_to_expiry",             # NO OF DAYS TO EXPIRY
    "total_theta_gain_loss",      # TOTAL THETA GAIN/LOSS
    "per_day_theta_gain_loss",    # PER DAY THETA GAIN/LOSS
    "opt_entry_qty",              # OPT ENTRY QTY
    "opt_entry_price",            # OPT ENTRY PRICE
    "opt_exit_price",             # OPT EXIT PRICE
    "fut_qty",                     # FUT QTY
    "fut_entry_price",            # FUT ENTRY PRICE
    "fut_exit_price",             # FUT EXIT PRICE
    "upside_distance",            # UPSIDE DISTANCE
    "down_distance",              # DOWN DISTANCE
    "basket_distance",            # BASKET DISTANCE
    "total_baskets",              # TOTAL BASKETS
    "basket_loss",                # BASKET LOSS
    "total_mm_loss",              # TOTAL MM LOSS
    "upside_opt_pnl",             # UPSIDE OPT PNL
    "down_opt_pnl",               # DOWN OPT PNL
    "upside_fut_pnl",             # UPSIDE FUT PNL
    "downside_fut_pnl",           # DOWNSIDE FUT PNL
    "estimated_upside_net_pnl",   # ESTIMATED UPSIDE NET PNL
    "estimated_downside_net_pnl", # ESTIMATED DOWNSIDE NET PNL
    "net_booked_pnl",             # NET BOOKED PNL
    "market_making_pl",           # MARKET MAKING PL
    "apy",                         # APY
    "end_date",                    # END DATE
    "status",                      # STATUS
]

CREATE_TABLE_SQL = f"""
CREATE TABLE IF NOT EXISTS {TABLE_NAME} (
    id                          INT AUTO_INCREMENT PRIMARY KEY,
    entry_date                  DATE            NOT NULL,
    token                       VARCHAR(40)     NOT NULL,
    option_type                 VARCHAR(10)     NOT NULL DEFAULT 'PUT',
    investment                  DECIMAL(18,4),
    options_strike              VARCHAR(60),
    expiry                      DATE,
    days_to_expiry              INT,
    total_theta_gain_loss       DECIMAL(18,4),
    per_day_theta_gain_loss     DECIMAL(18,4),
    opt_entry_qty               DECIMAL(18,4),
    opt_entry_price             DECIMAL(18,4),
    opt_exit_price              DECIMAL(18,4),
    fut_qty                     DECIMAL(18,4),
    fut_entry_price             DECIMAL(18,4),
    fut_exit_price              DECIMAL(18,4),
    upside_distance             DECIMAL(18,4),
    down_distance               DECIMAL(18,4),
    basket_distance             DECIMAL(18,4),
    total_baskets               DECIMAL(18,4),
    basket_loss                 DECIMAL(18,4),
    total_mm_loss               DECIMAL(18,4),
    upside_opt_pnl              DECIMAL(18,4),
    down_opt_pnl                DECIMAL(18,4),
    upside_fut_pnl             DECIMAL(18,4),
    downside_fut_pnl            DECIMAL(18,4),
    estimated_upside_net_pnl    DECIMAL(18,4),
    estimated_downside_net_pnl  DECIMAL(18,4),
    net_booked_pnl              DECIMAL(18,4),
    market_making_pl            DECIMAL(18,4),
    apy                         DECIMAL(18,4),
    end_date                    DATE,
    status                      VARCHAR(20)     NOT NULL DEFAULT 'open',
    created_at                  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
"""


def _server_connection():
    return mysql.connector.connect(**DB_CONFIG)


def get_connection():
    return mysql.connector.connect(database=DB_NAME, **DB_CONFIG)


def init_db():
    """Create the database (if missing) and the table. Safe to call repeatedly."""
    conn = _server_connection()
    cur = conn.cursor()
    try:
        cur.execute(
            f"CREATE DATABASE IF NOT EXISTS {DB_NAME} "
            "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
        )
    except mysql.connector.Error as err:
        if err.errno != errorcode.ER_DB_CREATE_EXISTS:
            raise
    conn.database = DB_NAME
    cur.execute(CREATE_TABLE_SQL)

    # Auto-migrate: add option_type to tables created before this column existed.
    try:
        cur.execute(
            f"ALTER TABLE {TABLE_NAME} ADD COLUMN option_type VARCHAR(10) "
            "NOT NULL DEFAULT 'PUT' AFTER token"
        )
    except mysql.connector.Error as err:
        if err.errno != errorcode.ER_DUP_FIELDNAME:  # 1060 = column already exists
            raise

    conn.commit()
    cur.close()
    conn.close()


def reset_db():
    """DROP the table and recreate it with the current schema. DELETES ALL DATA."""
    conn = get_connection()
    cur = conn.cursor()
    cur.execute(f"DROP TABLE IF EXISTS {TABLE_NAME}")
    cur.execute(CREATE_TABLE_SQL)
    conn.commit()
    cur.close()
    conn.close()


def insert_trade(data: dict) -> int:
    placeholders = ", ".join(["%s"] * len(COLUMNS))
    sql = f"INSERT INTO {TABLE_NAME} ({', '.join(COLUMNS)}) VALUES ({placeholders})"
    values = [data.get(c) for c in COLUMNS]
    conn = get_connection()
    cur = conn.cursor()
    cur.execute(sql, values)
    conn.commit()
    new_id = cur.lastrowid
    cur.close()
    conn.close()
    return new_id


def update_trade(trade_id: int, data: dict):
    """Update any subset of columns for an existing row."""
    fields = [c for c in COLUMNS if c in data]
    if not fields:
        return
    set_clause = ", ".join(f"{c} = %s" for c in fields)
    sql = f"UPDATE {TABLE_NAME} SET {set_clause} WHERE id = %s"
    values = [data[c] for c in fields] + [trade_id]
    conn = get_connection()
    cur = conn.cursor()
    cur.execute(sql, values)
    conn.commit()
    cur.close()
    conn.close()


def fetch_trades(status: str | None = None):
    conn = get_connection()
    cur = conn.cursor(dictionary=True)
    if status:
        cur.execute(
            f"SELECT * FROM {TABLE_NAME} WHERE status = %s ORDER BY entry_date DESC, id DESC",
            (status,),
        )
    else:
        cur.execute(f"SELECT * FROM {TABLE_NAME} ORDER BY entry_date DESC, id DESC")
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return rows


def delete_trade(trade_id: int):
    conn = get_connection()
    cur = conn.cursor()
    cur.execute(f"DELETE FROM {TABLE_NAME} WHERE id = %s", (trade_id,))
    conn.commit()
    cur.close()
    conn.close()


if __name__ == "__main__":
    init_db()
    print(f"Database '{DB_NAME}' and table '{TABLE_NAME}' are ready.")
