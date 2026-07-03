import Sparkline from "./Sparkline";
import { formatValue } from "../lib/fields";

const COLORS = {
  blue:   { text: "text-blue-600",    bg: "bg-blue-50",    stroke: "#3b82f6" },
  green:  { text: "text-emerald-600", bg: "bg-emerald-50", stroke: "#10b981" },
  purple: { text: "text-purple-600",  bg: "bg-purple-50",  stroke: "#8b5cf6" },
  orange: { text: "text-orange-500",  bg: "bg-orange-50",  stroke: "#f97316" },
  indigo: { text: "text-indigo-600",  bg: "bg-indigo-50",  stroke: "#6366f1" },
  teal:   { text: "text-teal-600",    bg: "bg-teal-50",    stroke: "#14b8a6" },
  red:    { text: "text-red-600",     bg: "bg-red-50",     stroke: "#ef4444" },
};

// signAware=true → override color to red when value < 0
export default function MetricCard({ label, value, format, color = "blue", signAware = false }) {
  const isNegative = signAware && value !== null && value !== undefined && value !== "" && Number(value) < 0;
  const c = COLORS[isNegative ? "red" : color] || COLORS.blue;
  return (
    <div className="rounded-xl border border-slate-100 bg-white p-4 shadow-card">
      <div className="flex items-center gap-2 mb-2">
        <span className={`grid h-7 w-7 place-items-center rounded-lg ${c.bg} ${c.text} text-xs`}>
          ◧
        </span>
        <span className="text-xs font-medium text-slate-500">{label}</span>
      </div>
      <div className={`text-xl font-bold ${c.text}`}>{formatValue(value, format)}</div>
      <div className="mt-2">
        <Sparkline seed={label} color={c.stroke} />
      </div>
    </div>
  );
}
