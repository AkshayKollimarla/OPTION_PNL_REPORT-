# Trading Bot Analytics Dashboard

A Next.js + React + Tailwind dashboard for grid trading bot analytics, backed by MySQL.

- **Dashboard** (`/`) — top metric cards (RTPS, RTP-PNL, Net-PNL, APY, …), a filter bar
  (token / from / to), and a full **Bot Details** panel. Reads the latest matching record from MySQL.
- **Manual Entry** (`/manual-entry`) — a separate sidebar page with a form for every field.
  On save, the record is inserted into MySQL and immediately appears on the dashboard.

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Configure MySQL**

   Copy the env template and fill in your credentials:

   ```bash
   copy .env.local.example .env.local   # Windows
   # cp .env.local.example .env.local   # macOS/Linux
   ```

   Edit `.env.local`:

   ```
   MYSQL_HOST=localhost
   MYSQL_PORT=3306
   MYSQL_USER=root
   MYSQL_PASSWORD=your_password
   MYSQL_DATABASE=trading_dashboard
   ```

3. **Create the database + table**

   ```bash
   npm run db:init
   ```

   (Or run `schema.sql` manually in MySQL Workbench / CLI.)

4. **Run the app**

   ```bash
   npm run dev
   ```

   Open http://localhost:3000

## Adding fields

All fields live in one place: [`lib/fields.js`](lib/fields.js). Add a field there and it flows
through the form, the API insert, and the dashboard automatically. Remember to add the matching
column to [`schema.sql`](schema.sql).

## Project structure

```
app/
  layout.js              # shell + sidebar
  page.js                # Dashboard
  manual-entry/page.js   # Manual Entry form
  api/entries/route.js   # GET (read/filter) + POST (insert)
components/
  Sidebar.js  MetricCard.js  Sparkline.js
lib/
  db.js                  # MySQL connection pool
  fields.js              # single source of truth for all fields
schema.sql               # database + table definition
scripts/init-db.js       # `npm run db:init`
```
