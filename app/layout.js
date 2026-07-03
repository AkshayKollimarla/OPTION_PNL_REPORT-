import "./globals.css";
import AppShell from "../components/AppShell";

export const metadata = {
  title: "Trading Bot Analytics",
  description: "Grid trading bot analytics dashboard with manual data entry",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="font-sans">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
