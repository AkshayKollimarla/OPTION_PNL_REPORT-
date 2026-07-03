import mysql from "mysql2/promise";

// v2 cache key — busts any pool cached before dateStrings:true was added
const CACHE_KEY = "_mysqlPool_v2";
let pool = global[CACHE_KEY];

if (!pool) {
  pool = mysql.createPool({
    host: process.env.MYSQL_HOST || "localhost",
    port: Number(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || "trading_dashboard",
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    decimalNumbers: true,
    dateStrings: true,   // keep DATE/DATETIME as "YYYY-MM-DD" strings, never Date objects
  });
  global[CACHE_KEY] = pool;
}

export default pool;
