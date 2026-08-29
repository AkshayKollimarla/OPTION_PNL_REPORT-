import "./globals.css";
import AppShell from "../components/AppShell";

export const metadata = {
  title: "Trading Bot Analytics",
  description: "Grid trading bot analytics dashboard with manual data entry",
};

// Runs before the first paint, so the stored theme is already on <html> when
// the page renders. Doing this in a useEffect instead would paint the light
// theme first and then repaint — the white flash every dark-mode user knows.
// Written as a string because it has to execute ahead of React hydrating.
const THEME_BOOT = `
(function () {
  try {
    var stored = localStorage.getItem('theme');
    var dark = stored === 'dark' ||
      (!stored && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
  } catch (e) {
    /* storage blocked - fall through to the light default */
  }
})();
`;

export default function RootLayout({ children }) {
  return (
    // suppressHydrationWarning: the script above mutates <html>'s class list
    // before React hydrates, so server and client markup differ here by
    // design.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body className="font-sans">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
