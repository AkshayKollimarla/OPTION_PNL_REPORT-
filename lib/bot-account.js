// Which grid-bot account runs a given options strategy.
//
// Two naming schemes have to be bridged, and the book uses both:
//
//   Hyperliquid  one account holds every coin, named the same on both sides.
//                Options HYPER-USMARKETS -> bot HYPER-USMARKETS, with the coin
//                carried in token_symbol.
//   Deribit      one account per coin, with the coin folded into the bot's
//                name. Options HFT3 on BTC -> bot BTC-HFT3; HFT1 on SOL ->
//                SOL-HFT1; and HIDDEN-ROAD abbreviates to HIDDEN, so ETH there
//                is ETH-HIDDEN.
//
// Returning null is a real answer: options HFT5 trades ETH and SOL, and the
// grid bot has no HFT5 account at all. Guessing one would put another coin's
// bot figures beside the strategy.

/** The plain coin behind a canonical label: SOL_USDC and SOL-HFT1 are both SOL. */
export function plainBaseCoin(token) {
  const base = String(token || "").split("-")[0].trim().toUpperCase();
  return base === "SOL_USDC" ? "SOL" : base;
}

/**
 * @param coin            the strategy's coin, canonical or raw
 * @param optionsAccount  the options account the strategy is booked to
 * @param botAccounts     bot account names, as the bot entry log spells them
 * @returns the matching bot account name as given, or null
 */
export function botAccountFor(coin, optionsAccount, botAccounts) {
  const acct = String(optionsAccount || "").trim().toUpperCase();
  if (!acct) return null;
  const names = (botAccounts || []).filter(Boolean).map(String);

  // Same name on both sides: one bot account holding many coins.
  const direct = names.find((n) => n.toUpperCase() === acct);
  if (direct) return direct;

  const composed = `${plainBaseCoin(coin)}-${acct}`;
  const exact = names.find((n) => n.toUpperCase() === composed);
  if (exact) return exact;

  // An abbreviated bot name: ETH-HIDDEN against ETH-HIDDEN-ROAD. The dash is
  // required so ETH-HID could not match, and the longest match wins so a
  // shorter name cannot claim a strategy a more specific one owns.
  const prefixed = names
    .filter((n) => {
      const u = n.toUpperCase();
      return composed.startsWith(u) && composed[u.length] === "-";
    })
    .sort((a, b) => b.length - a.length);
  return prefixed[0] || null;
}
