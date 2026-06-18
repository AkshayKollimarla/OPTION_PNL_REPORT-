"""
Configuration template.

Copy this file to `config.py` and fill in your real MySQL credentials.
`config.py` is git-ignored so your password is never committed.

You can also override any value with environment variables:
DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, TABLE_NAME.
"""
import os

DB_CONFIG = {
    "host": os.getenv("DB_HOST", "localhost"),
    "port": int(os.getenv("DB_PORT", "3306")),
    "user": os.getenv("DB_USER", "root"),
    "password": os.getenv("DB_PASSWORD", "YOUR_MYSQL_PASSWORD"),  # <-- change me
}

# Database + table that hold the report.
DB_NAME = os.getenv("DB_NAME", "options_pnl_report")
TABLE_NAME = os.getenv("TABLE_NAME", "options_trades")
