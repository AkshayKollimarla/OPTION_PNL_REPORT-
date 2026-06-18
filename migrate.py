"""
Apply the new schema to an existing database.

WARNING: this DROPS the existing table and recreates it with the new columns,
so any rows already stored are deleted. Run only if you're OK losing old data.

Run with:  python migrate.py
"""
import db

if __name__ == "__main__":
    db.init_db()      # ensure database exists
    db.reset_db()     # drop + recreate table with new columns
    print(f"Table '{db.TABLE_NAME}' recreated with the new (image) columns.")
