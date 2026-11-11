// What one unit of "size" means on a leg.
//
// A US equity option contract is 100 shares. The book stores quantities in
// SHARES, because that is what the arithmetic needs -- prices are per share,
// so the P&L is (mid - entry) x shares, and an order goes to Alpaca in shares
// too. None of that changes. What changes is the typing: nobody wants to key
// 200 to mean two contracts, so the Size box on the strip is in CONTRACTS and
// this is the factor between the two.
//
// Deribit must NOT get the same treatment. Its options are sized in the coin
// itself, where 1 means one ETH, so multiplying by a hundred there would
// record a position a hundred times the real one and report a P&L to match.
// Hence a factor that depends on the venue rather than a constant.
//
// The venue is decided by the CREDENTIAL, never by the account's exchange
// column: that column is a reporting label, and the US equity account is
// deliberately labelled "hyperliquid" so its strategies group with the bot
// entries they hedge against. This is the same rule the server routes on, and
// it lives here so the two cannot drift apart.

/**
 * Does this credential belong to Alpaca? Paper key ids start PK, live AK.
 */
export function isAlpacaKey(key) {
  return /^(PK|AK)[A-Z0-9]{6,}$/i.test(String(key || "").trim());
}

// Shares per US equity option contract.
export const US_EQUITY_CONTRACT = 100;

/**
 * How many stored units one typed unit of size is worth, for this account.
 *
 * An account that has not been chosen yet gets 1. That is the safe way round:
 * it means a number typed before an account is picked is taken at face value
 * rather than being silently multiplied by a hundred.
 */
export function contractSize(account) {
  return isAlpacaKey(account?.api_key) ? US_EQUITY_CONTRACT : 1;
}

/**
 * Stored quantity (shares) to what the Size box shows (contracts).
 *
 * Blank stays blank. Number("") is 0, and a leg with no size showing a
 * confident 0 is the same false-zero that made every unfilled leg report a
 * P&L of $0.00.
 */
export function toLots(qty, size) {
  if (qty === "" || qty === null || qty === undefined) return "";
  const n = Number(qty);
  if (!Number.isFinite(n)) return "";
  // Six places, not rounding to whole lots: 600 shares must read 6, and an
  // odd 150-share holding must read 1.5 rather than be rounded into a lie
  // about the size of the position.
  return Math.round((n / (size || 1)) * 1e6) / 1e6;
}

/**
 * What the Size box holds (contracts) to the stored quantity (shares).
 */
export function toQuantity(lots, size) {
  if (lots === "" || lots === null || lots === undefined) return "";
  const n = Number(lots);
  if (!Number.isFinite(n)) return "";
  return Math.round(n * (size || 1) * 1e6) / 1e6;
}
