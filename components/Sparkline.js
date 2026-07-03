// Tiny decorative sparkline. Deterministic shape derived from a seed string
// so each card looks distinct without needing real time-series data.
export default function Sparkline({ seed = "x", color = "#3b82f6" }) {
  const points = makePoints(seed);
  const w = 120;
  const h = 32;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const range = max - min || 1;
  const step = w / (points.length - 1);
  const d = points
    .map((p, i) => {
      const x = i * step;
      const y = h - ((p - min) / range) * h;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-8" preserveAspectRatio="none">
      <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function makePoints(seed) {
  let n = 0;
  for (let i = 0; i < seed.length; i++) n = (n * 31 + seed.charCodeAt(i)) % 9973;
  const out = [];
  for (let i = 0; i < 14; i++) {
    n = (n * 1103515245 + 12345) % 2147483648;
    out.push((n % 100) / 100);
  }
  return out;
}
