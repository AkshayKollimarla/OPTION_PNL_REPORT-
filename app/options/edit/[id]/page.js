"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import AddStrategy from "../../add/page";

function toFormDate(d) {
  if (!d) return "";
  const s = String(d);
  // Already YYYY-MM-DD — use directly, no parsing needed
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dt = new Date(s.replace(" ", "T"));
  if (isNaN(dt)) return "";
  // Use local-time getters to avoid UTC-offset shifting the date
  const y  = dt.getFullYear();
  const m  = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default function EditStrategy() {
  const { id }        = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch(`/api/options/trades/${id}`)
      .then((r) => r.json())
      .then((j) => {
        if (j.error) throw new Error(j.error);
        const t = j.trade;
        // Convert date fields to YYYY-MM-DD for date inputs
        setData({
          ...t,
          entry_date: toFormDate(t.entry_date),
          expiry:     toFormDate(t.expiry),
          end_date:   toFormDate(t.end_date),
        });
      })
      .catch((e) => setError(e.message));
  }, [id]);

  if (error) return <div className="p-6 text-sm text-red-600">{error}</div>;
  if (!data) return <div className="p-6 text-sm text-slate-400">Loading strategy…</div>;

  return <AddStrategy initialData={data} tradeId={Number(id)} isEdit />;
}
