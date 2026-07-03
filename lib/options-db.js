import mysql from "mysql2/promise";

// v2 cache key — busts any pool cached before dateStrings:true was added
const CACHE_KEY = "_optionsMysqlPool_v2";
let pool = global[CACHE_KEY];

if (!pool) {
  pool = mysql.createPool({
    host:             process.env.OPTIONS_MYSQL_HOST     || "localhost",
    port:             Number(process.env.OPTIONS_MYSQL_PORT) || 3306,
    user:             process.env.OPTIONS_MYSQL_USER     || "root",
    password:         process.env.OPTIONS_MYSQL_PASSWORD || "",
    database:         process.env.OPTIONS_MYSQL_DATABASE || "options_pnl_report",
    waitForConnections: true,
    connectionLimit:  10,
    decimalNumbers:   true,
    dateStrings:      true,   // keep DATE/DATETIME as "YYYY-MM-DD" strings, never Date objects
  });
  global[CACHE_KEY] = pool;
}

export default pool;
