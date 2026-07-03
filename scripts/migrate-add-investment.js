// Adds the `investment` column to an existing bot_entries table.
// Safe to run multiple times (uses IF NOT EXISTS).
// Usage:  node scripts/migrate-add-investment.js

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
      AND COLUMN_NAME = 'investment'
  `);

  if (rows[0].cnt > 0) {
    console.log("✓ Column 'investment' already exists — nothing to do.");
  } else {
    await conn.query(`
      ALTER TABLE bot_entries
      ADD COLUMN investment DECIMAL(20,4) DEFAULT 0
      AFTER total_distance
    `);
    console.log("✓ Column 'investment' added successfully.");
  }
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
