// Standard normal CDF via Abramowitz & Stegun rational approximation
function normCDF(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p =
    d *
    t *
    (0.3193815 +
      t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
  return x > 0 ? 1 - p : p;
}

// Black-Scholes option price
// S  = current underlying price
// K  = strike price
// T  = time to expiry in years (use 0 for expiry payoff)
// r  = risk-free rate (e.g. 0.05)
// sigma = implied volatility (e.g. 0.30 for 30%)
// type  = "CALL" | "PUT"
export function bsPrice(S, K, T, r, sigma, type) {
  if (S <= 0 || K <= 0 || sigma <= 0) return 0;
  if (T <= 0) {
    return type === "CALL" ? Math.max(S - K, 0) : Math.max(K - S, 0);
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  if (type === "CALL") {
    return S * normCDF(d1) - K * Math.exp(-r * T) * normCDF(d2);
  }
  return K * Math.exp(-r * T) * normCDF(-d2) - S * normCDF(-d1);
}

// P/L at expiry (intrinsic only)
export function expiryPnl(S, K, optType, entryPrice, qty) {
  const intrinsic = optType === "CALL" ? Math.max(S - K, 0) : Math.max(K - S, 0);
  return (intrinsic - entryPrice) * qty;
}

// P/L at given DTE using Black-Scholes
export function currentPnl(S, K, T_years, r, sigma, optType, entryPrice, qty) {
  const price = bsPrice(S, K, T_years, r, sigma, optType);
  return (price - entryPrice) * qty;
}

// Standard normal PDF — the derivative normCDF is the integral of, which is
// what vega is built from.
function normPDF(x) {
  return 0.3989422804014327 * Math.exp((-x * x) / 2);
}

function d1Of(S, K, T, r, sigma) {
  return (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
}

/**
 * Delta: how much the option moves for a one-point move in the underlying.
 *
 * At expiry there is no curve left, only the payoff, so delta is 1 or 0 on
 * the two sides of the strike rather than something in between.
 */
export function bsDelta(S, K, T, r, sigma, type) {
  const call = String(type).toUpperCase().startsWith("C");
  if (!(S > 0) || !(K > 0)) return null;
  if (T <= 0 || sigma <= 0) {
    const itm = call ? S > K : S < K;
    return call ? (itm ? 1 : 0) : (itm ? -1 : 0);
  }
  const nd1 = normCDF(d1Of(S, K, T, r, sigma));
  return call ? nd1 : nd1 - 1;
}

export function bsVega(S, K, T, r, sigma) {
  if (!(S > 0) || !(K > 0) || T <= 0 || sigma <= 0) return 0;
  return S * normPDF(d1Of(S, K, T, r, sigma)) * Math.sqrt(T);
}

/**
 * The volatility that makes Black-Scholes return the price the market is
 * showing. There is no closed form, so it is solved for.
 *
 * Bisection, not Newton. Newton converges in a handful of steps where vega is
 * healthy, which is most of a chain, but it stalls out on the deep wings
 * where vega is almost nothing and a single step can throw sigma negative.
 * Bisection cannot stall. A chain is a few hundred solves of sixty halvings,
 * which costs nothing worth measuring, and never returning a wrong answer is
 * worth more here than returning one sooner.
 *
 * A price below intrinsic has no solution at any volatility; null says so
 * rather than returning the edge of the search range as though it were one.
 */
export function impliedVol(price, S, K, T, r, type) {
  const call = String(type).toUpperCase().startsWith("C");
  if (!(price > 0) || !(S > 0) || !(K > 0) || !(T > 0)) return null;
  const intrinsic = call ? Math.max(S - K * Math.exp(-r * T), 0) : Math.max(K * Math.exp(-r * T) - S, 0);
  if (price <= intrinsic) return null;
  // Above the underlying a call cannot be priced by any volatility.
  if (call && price >= S) return null;
  if (!call && price >= K) return null;

  let lo = 0.0001, hi = 5;
  if (bsPrice(S, K, T, r, hi, call ? "CALL" : "PUT") < price) return null;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (bsPrice(S, K, T, r, mid, call ? "CALL" : "PUT") < price) lo = mid; else hi = mid;
    if (hi - lo < 1e-6) break;
  }
  return (lo + hi) / 2;
}
