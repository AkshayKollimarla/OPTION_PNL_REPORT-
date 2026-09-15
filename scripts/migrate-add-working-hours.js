// Adds the `working_hours` column to an existing bot_entries table.
// Safe to run multiple times (checks information_schema first).
// Usage:  node scripts/migrate-add-working-hours.js
//
// Per Hour RTPS used to be RTPS / 24 unconditionally. It is now RTPS divided by
// the hours the bot actually ran, entered per row. Existing rows take the
// default of 24, which is exactly what their stored per_hour_rtps was computed
// with — every row checked before this migration satisfied
// per_hour_rtps = rtps / 24 — so no historical figure changes.

const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

loadEnv();

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST || "localhost",
    port: Number(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || "trading_dashboard",
  });

  const [rows] = await conn.query(`
    SELECT COUNT(*) AS cnt
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'bot_entries'
      AND COLUMN_NAME = 'working_hours'
  `);

  if (rows[0].cnt > 0) {
    console.log("✓ Column 'working_hours' already exists — nothing to do.");
  } else {
    // NOT NULL with a default: a row can never be missing its hours, so Per
    // Hour RTPS never has to guess what to divide by.
    await conn.query(`
      ALTER TABLE bot_entries
      ADD COLUMN working_hours DECIMAL(6,2) NOT NULL DEFAULT 24
      AFTER per_hour_rtps
    `);
    console.log("✓ Column 'working_hours' added successfully.");
  }

  const [[check]] = await conn.query(`
    SELECT COUNT(*) AS total_rows,
           SUM(working_hours = 24) AS rows_at_24,
           SUM(rtps <> 0 AND ABS(per_hour_rtps - rtps / working_hours) > 0.01) AS rows_inconsistent
    FROM bot_entries
  `);
  console.log(
    `  ${check.total_rows} rows · ${check.rows_at_24} at 24 hours · ` +
    `${check.rows_inconsistent} where per_hour_rtps ≠ rtps / working_hours`
  );
  await conn.end();
}

function loadEnv() {
  for (const name of [".env.local", ".env"]) {
    const p = path.join(__dirname, "..", name);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    break;
  }
}

main().catch((err) => { console.error("✗", err.message); process.exit(1); });
