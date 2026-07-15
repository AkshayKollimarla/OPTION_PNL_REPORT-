"use client";

import { useState, useEffect } from "react";

const EXCHANGES = ["deribit", "binance", "bybit", "okx", "hyperliquid", "other"];

const EMPTY = {
  name: "", exchange: "deribit", api_key: "", api_secret: "", private_key: "", testnet: false,
};

const inp = "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 focus:border-brand focus:outline-none";

function Field({ label, name, value, onChange, type = "text", placeholder = "" }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="block text-sm font-medium text-slate-600">{label}</label>
      <input
        type={type}
        name={name}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        autoComplete="off"
        className={inp}
      />
    </div>
  );
}

export default function AccountsPage() {
  const [accounts, setAccounts]   = useState([]);
  const [form, setForm]           = useState(EMPTY);
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState("");
  const [success, setSuccess]     = useState("");
  const [deleting, setDeleting]   = useState(null);
  const [testing,  setTesting]   = useState(null);   // account id being tested
  const [testResult, setTestResult] = useState({});   // { [id]: { ok, message, error, hint, scope, endpoint, client_id_preview } }

  async function load() {
    try {
      const res = await fetch("/api/accounts");
      const { accounts } = await res.json();
      setAccounts(accounts || []);
    } catch {
      setError("Failed to load accounts");
    }
  }

  useEffect(() => { load(); }, []);

  function handleChange(e) {
    const { name, value, type, checked } = e.target;
    setForm(f => ({ ...f, [name]: type === "checkbox" ? checked : value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(""); setSuccess("");
    if (!form.name.trim() || !form.exchange) {
      setError("Name and Exchange are required"); return;
    }
    setSaving(true);
    try {
      const res  = await fetch("/api/accounts", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Save failed"); return; }
      setSuccess(`Account "${form.name}" saved (ID ${data.id})`);
      setForm(EMPTY);
      load();
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  }

  async function handleTestAuth(id) {
    setTesting(id);
    setTestResult(prev => ({ ...prev, [id]: null }));
    try {
      const res  = await fetch(`/api/accounts/${id}/test-auth`, { method: "POST" });
      const data = await res.json();
      setTestResult(prev => ({ ...prev, [id]: data }));
    } catch (e) {
      setTestResult(prev => ({ ...prev, [id]: { ok: false, error: `Network error: ${e.message}` } }));
    } finally {
      setTesting(null);
    }
  }

  async function handleDelete(id, name) {
    if (!confirm(`Delete account "${name}"?`)) return;
    setDeleting(id);
    try {
      await fetch(`/api/accounts/${id}`, { method: "DELETE" });
      load();
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">

      {/* Header */}
      <header className="flex h-16 items-center border-b border-slate-200">
        <div>
          <h1 className="text-lg font-bold text-slate-800">Exchange Accounts</h1>
          <p className="text-xs text-slate-400 mt-0.5">
            Store credentials for live data and trade execution. Secrets are saved in the database.
          </p>
        </div>
      </header>

      {/* Add Account Form */}
      <div className="rounded-xl border border-slate-100 bg-white p-6 shadow-card space-y-4">
        <h2 className="text-sm font-semibold text-slate-700">Add New Account</h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Account Name" name="name" value={form.name}
              onChange={handleChange} placeholder="e.g. Deribit Main" />

            <div className="flex flex-col gap-1">
              <label className="block text-sm font-medium text-slate-600">Exchange</label>
              <select
                name="exchange"
                value={form.exchange}
                onChange={handleChange}
                className={inp}
              >
                {EXCHANGES.map(ex => (
                  <option key={ex} value={ex}>{ex.charAt(0).toUpperCase() + ex.slice(1)}</option>
                ))}
              </select>
            </div>
          </div>

          <Field label="API Key / Client ID" name="api_key" value={form.api_key}
            onChange={handleChange} placeholder="Public key or client_id" />

          <Field label="API Secret / Client Secret" name="api_secret" type="password"
            value={form.api_secret} onChange={handleChange} placeholder="Secret key or client_secret" />

          <Field label="Private Key (Hyperliquid / wallet keys only)" name="private_key" type="password"
            value={form.private_key} onChange={handleChange} placeholder="0x… wallet private key (if required)" />

          <div className="flex items-center gap-3">
            <input
              type="checkbox" id="testnet" name="testnet"
              checked={form.testnet} onChange={handleChange}
              className="h-4 w-4 accent-brand"
            />
            <label htmlFor="testnet" className="text-sm text-slate-600">
              Use Testnet / Paper Trading
            </label>
          </div>

          {error   && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}
          {success && <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">{success}</p>}

          <button
            type="submit"
            disabled={saving}
            className="rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {saving ? "Saving…" : "Save Account"}
          </button>
        </form>
      </div>

      {/* Accounts List */}
      <div className="rounded-xl border border-slate-100 bg-white p-6 shadow-card space-y-3">
        <h2 className="text-sm font-semibold text-slate-700">Saved Accounts</h2>

        {accounts.length === 0 && (
          <p className="text-sm text-slate-400">No accounts saved yet.</p>
        )}

        <div className="space-y-3">
          {accounts.map(acct => (
            <div key={acct.id}
              className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-3 space-y-2">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-slate-800">{acct.name}</span>
                    {acct.testnet ? (
                      <span className="rounded-full bg-yellow-100 border border-yellow-200 px-2 py-0.5 text-xs font-medium text-yellow-700">
                        Testnet
                      </span>
                    ) : (
                      <span className="rounded-full bg-emerald-100 border border-emerald-200 px-2 py-0.5 text-xs font-medium text-emerald-700">
                        Live
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    <span className="capitalize font-medium">{acct.exchange}</span>
                    {acct.api_key && (
                      <>
                        <span>·</span>
                        <span>Key: {acct.api_key.slice(0, 8)}…</span>
                      </>
                    )}
                    <span>·</span>
                    <span>ID #{acct.id}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleTestAuth(acct.id)}
                    disabled={testing === acct.id}
                    className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-600 hover:bg-blue-100 disabled:opacity-50 transition-colors"
                  >
                    {testing === acct.id ? "Testing…" : "Test Connection"}
                  </button>
                  <button
                    onClick={() => handleDelete(acct.id, acct.name)}
                    disabled={deleting === acct.id}
                    className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100 disabled:opacity-50 transition-colors"
                  >
                    {deleting === acct.id ? "…" : "Delete"}
                  </button>
                </div>
              </div>

              {/* Test result */}
              {testResult[acct.id] && (
                <div className={`rounded-lg border px-3 py-2 text-xs space-y-1 ${
                  testResult[acct.id].ok
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : "border-red-200 bg-red-50 text-red-700"
                }`}>
                  {testResult[acct.id].ok ? (
                    <>
                      <p className="font-semibold">✓ {testResult[acct.id].message}</p>
                      {testResult[acct.id].scope && <p>Scope: <span className="font-mono">{testResult[acct.id].scope}</span></p>}
                      <p className="text-emerald-500">Endpoint: {testResult[acct.id].endpoint}</p>
                    </>
                  ) : (
                    <>
                      <p className="font-semibold">✗ {testResult[acct.id].error}</p>
                      {testResult[acct.id].hint && (
                        <p className="text-orange-600 font-medium">⚠ {testResult[acct.id].hint}</p>
                      )}
                      {testResult[acct.id].client_id_preview && (
                        <p>Client ID used: <span className="font-mono">{testResult[acct.id].client_id_preview}</span></p>
                      )}
                      {testResult[acct.id].endpoint && (
                        <p>Endpoint: {testResult[acct.id].endpoint}</p>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <p className="text-xs text-slate-400 px-1">
        Currently live data and execution are supported for <strong>Deribit</strong>. Other exchanges will be available in future updates.
      </p>
    </div>
  );
}
