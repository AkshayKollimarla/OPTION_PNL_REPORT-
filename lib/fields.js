// Single source of truth for every field the bot tracks.
// Used by the manual-entry form, the API insert, and the dashboard.
// format: "currency" | "percent" | "number" | "text"

export const METRIC_CARDS = [
  { key: "rtps", label: "RTPS", format: "number", color: "blue" },
  { key: "rtp_pnl", label: "RTP-PNL", format: "currency", color: "green" },
  { key: "per_hour_rtps", label: "Per Hour RTPS", format: "number", color: "purple" },
  { key: "rebates", label: "Rebates", format: "currency", color: "orange" },
  { key: "gamma_booked", label: "Gamma Booked", format: "currency", color: "indigo" },
  { key: "flatten_pnl", label: "Flatten PNL", format: "currency", color: "teal" },
  { key: "net_pnl", label: "Net-PNL", format: "currency", color: "green" },
  { key: "volume", label: "Volume", format: "currency", color: "blue" },
  { key: "apy", label: "APY", format: "percent", color: "purple" },
];

export const BOT_DETAILS_LEFT = [
  { key: "investment", label: "Investment", format: "currency" },
  { key: "entry_futures", label: "Entry Futures", format: "currency" },
  { key: "entry_futures_price", label: "Entry Futures Price", format: "currency" },
  { key: "bot_entry_price", label: "Bot Entry Price", format: "currency" },
  { key: "market_making_qty", label: "Market Making Qty", format: "number" },
  { key: "average_spread", label: "Average Spread", format: "percent" },
  { key: "target_spread", label: "Target Spread", format: "percent" },
  { key: "basket_distance", label: "Basket Distance", format: "percent" },
  { key: "total_distance", label: "Total Distance", format: "percent" },
];

export const BOT_DETAILS_RIGHT = [
  { key: "total_steps", label: "Total Steps", format: "number" },
  { key: "per_step_qty", label: "Per Step Qty", format: "number" },
  { key: "rtp_value", label: "RTP Value", format: "number" },
  { key: "total_baskets_one_side", label: "Total Baskets One Side", format: "number" },
  { key: "basket_loss", label: "Basket Loss", format: "currency" },
  { key: "total_baskets", label: "Total Baskets", format: "number" },
  { key: "daily_loss", label: "Daily Loss", format: "currency" },
  { key: "basket_max_qty", label: "Basket Max Qty", format: "number" },
  { key: "upper_limit", label: "Upper Limit", format: "currency" },
  { key: "lower_limit", label: "Lower Limit", format: "currency" },
];

// Header fields (token + datetime) handled separately in the form.
export const HEADER_FIELDS = [
  { key: "token_name", label: "Token Name", format: "text", placeholder: "ETH-USD" },
  { key: "token_symbol", label: "Token Symbol", format: "text", placeholder: "Ethereum" },
  { key: "account", label: "Account", format: "text", placeholder: "e.g. Main, Sub-1" },
];

// Every numeric/text column, in DB insert order.
export const ALL_FIELDS = [
  ...HEADER_FIELDS,
  ...METRIC_CARDS,
  ...BOT_DETAILS_LEFT,
  ...BOT_DETAILS_RIGHT,
];

export function formatValue(value, format) {
  if (value === null || value === undefined || value === "") return "—";
  const num = Number(value);
  switch (format) {
    case "currency":
      return `$${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    case "percent":
      return `${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
    case "number":
      return num.toLocaleString(undefined, { maximumFractionDigits: 4 });
    default:
      return String(value);
  }
}
