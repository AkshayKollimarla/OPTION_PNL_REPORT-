// What an option form should change when its option chain (re)loads.
//
// Shared by Add Strategy and the Combined Simulator, which both reload the
// chain whenever the account or token changes.
//
// A saved strategy's expiry and strike are kept exactly as saved — even when
// that expiry has passed and is no longer listed — until they are changed by
// hand. Both pages used to decide this from a "preserve saved values" flag that
// Refresh clears, so after one refresh any later chain reload silently moved
// the form to the nearest expiry and wiped its strike.
//
//   pickExpiry  — replace the expiry with the nearest listed one
//   clearStrike — empty the strike
export function chainReloadAction({ currentExpiry, listedExpiries, previousToken, token }) {
  // A new form, or a leg with no expiry yet: start from the nearest expiry.
  if (!currentExpiry) return { pickExpiry: true, clearStrike: true };

  const tokenSwitched = Boolean(previousToken) && previousToken !== token;
  if (tokenSwitched) {
    // The strike belonged to the previous underlying, so it always goes. The
    // expiry is kept when the new token lists it — weekly dates are usually
    // shared — and replaced only when it does not.
    const listed = (listedExpiries || []).some((e) => e.date === currentExpiry);
    return { pickExpiry: !listed, clearStrike: true };
  }

  // Same token, chain merely reloaded (account change, refresh, remount).
  return { pickExpiry: false, clearStrike: false };
}

// Today's date on the US options calendar, as YYYY-MM-DD, to label a saved
// expiry that has passed. New York rather than UTC or the browser's zone: an
// option trades until its expiry day ends there.
export function usMarketToday(now = new Date()) {
  return now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}
