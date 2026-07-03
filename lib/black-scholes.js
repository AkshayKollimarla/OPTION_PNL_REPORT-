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
