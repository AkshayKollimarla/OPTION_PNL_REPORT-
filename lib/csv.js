// CSV export, shared by the pages that offer a download.
//
// Written by hand rather than by joining with commas: a token name with a
// comma in it, a note with a line break, or a figure that happens to start
// with "=" each break a naive join, and the file only misbehaves once it is
// open in someone's spreadsheet.

// Anything a spreadsheet would read as a formula rather than as text. Excel
// and Sheets both execute a cell beginning =, +, @ or a control character, so
// a value arriving from the database could otherwise run on open. Numbers are
// left alone -- a negative figure starts with "-" and must stay a number.
const FORMULA_START = /^[=+@\t\r]/;
// A value that is a number all the way through is exempt. A merely
// number-ish one like "+1 more" is text, and Excel runs it.
const NUMERIC = /^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/;

function cell(value) {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (FORMULA_START.test(s) && !NUMERIC.test(s)) s = `'${s}`;
  // Quote only when it has to be quoted, so the file stays readable.
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Rows as CSV text.
 *
 * @param rows    the data, in the order it should appear
 * @param columns [{ header, value: (row) => any }]
 */
export function toCsv(rows, columns) {
  const lines = [columns.map((c) => cell(c.header)).join(",")];
  for (const row of rows || []) {
    lines.push(columns.map((c) => cell(c.value(row))).join(","));
  }
  // CRLF: the line ending the CSV spec asks for, and the one Excel expects.
  return lines.join("\r\n") + "\r\n";
}

/**
 * Hand the file to the browser.
 *
 * The BOM is what makes Excel open it as UTF-8 rather than as the local
 * codepage, which is the difference between a clean file and one full of
 * mojibake the moment a symbol is not plain ASCII.
 */
export function downloadCsv(filename, csvText) {
  if (typeof window === "undefined") return;
  const blob = new Blob(["﻿" + csvText], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoked on the next tick: revoking immediately can cancel the download in
  // some browsers before it has read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A filename stamped with what it holds, e.g. entry-log-2026-10-01_2026-10-12.csv */
export function csvName(prefix, from, to) {
  const span = [from, to].filter(Boolean);
  const stamp = span.length ? [...new Set(span)].join("_") : new Date().toISOString().slice(0, 10);
  return `${prefix}-${stamp}.csv`;
}

/** A number for a spreadsheet: plain digits, no currency symbol, no thousands separator. */
export function num(value, places = 2) {
  const n = Number(value);
  if (value === null || value === undefined || value === "" || !Number.isFinite(n)) return "";
  return n.toFixed(places);
}

/**
 * PnL earned per RTP: the RTP PnL divided by the number of RTPs behind it.
 *
 * Blank rather than zero when there were no RTPs -- nothing was earned per
 * RTP because there was no RTP, and a 0 would average into a column as though
 * it were a real reading.
 */
export function perRtpPnl(rtpPnl, rtps) {
  // Number(null) and Number("") are both 0, which is finite, so an absent
  // figure would otherwise read as a real zero.
  const n = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));
  const p = n(rtpPnl);
  const r = n(rtps);
  if (!Number.isFinite(p) || !Number.isFinite(r) || r === 0) return null;
  return p / r;
}
