// The name one option leg is looked up by, shared between the page that asks
// for live prices and the server that fetches them.
//
// In its own file with no imports: lib/live-legs.js talks to MySQL, and a
// client component importing this from there dragged the database driver --
// and node:buffer with it -- into the browser bundle.
export const legKey = ({ token, expiry, strike, optType }) =>
  `${String(token).toUpperCase()}|${expiry}|${Number(strike)}|${String(optType).toUpperCase().startsWith("C") ? "CALL" : "PUT"}`;
