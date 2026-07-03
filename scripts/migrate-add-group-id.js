const fs    = require("fs");
const path  = require("path");
const mysql = require("mysql2/promise");

loadEnv();

async function main() {
  const conn = await mysql.createConnection({
    host:     process.env.OPTIONS_MYSQL_HOST     || "localhost",
    port:     Number(process.env.OPTIONS_MYSQL_PORT) || 3306,
    user:     process.env.OPTIONS_MYSQL_USER     || "root",
    password: process.env.OPTIONS_MYSQL_PASSWORD || "",
    database: process.env.OPTIONS_MYSQL_DATABASE || "options_pnl_report",
  });

  const [rows] = await conn.query(`
    SELECT COUNT(*) AS cnt
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'options_trades'
      AND COLUMN_NAME  = 'group_id'
  `);

  if (rows[0].cnt > 0) {
    console.log("✓ Column 'group_id' already exists — nothing to do.");
  } else {
    await conn.query("ALTER TABLE options_trades ADD COLUMN group_id VARCHAR(64) NULL DEFAULT NULL");
    console.log("✓ Column 'group_id' added to options_trades.");
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
