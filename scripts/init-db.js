// Creates the database + table from schema.sql.
// Usage:  npm run db:init
// Reads MySQL credentials from .env.local (or environment variables).

const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

loadEnvLocal();

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");

  // Connect WITHOUT a database so the CREATE DATABASE statement can run.
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST || "localhost",
    port: Number(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    multipleStatements: true,
  });

  console.log("Connected to MySQL. Applying schema.sql …");
  await conn.query(schema);
  console.log("✓ Database and table are ready.");
  await conn.end();
}

function loadEnvLocal() {
  // Check .env.local first, fall back to .env
  const candidates = [".env.local", ".env"];
  for (const name of candidates) {
    const p = path.join(__dirname, "..", name);
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
    break; // stop after the first file found
  }
}

main().catch((err) => {
  console.error("✗ Failed:", err.message);
  process.exit(1);
});
