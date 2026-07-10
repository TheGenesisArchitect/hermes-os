import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hermes OS",
  description: "Financial copilot, DeFi dashboard, and agentic quant harness",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <header className="border-b px-6 py-3" style={{ borderColor: "var(--border)" }}>
          <div className="mx-auto flex max-w-6xl items-center gap-3">
            <Link href="/" className="text-lg font-semibold tracking-tight">
              Hermes<span style={{ color: "var(--series-1)" }}> OS</span>
            </Link>
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              scanner · paper scalper · signal intelligence
            </span>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-6">{children}</main>
      </body>
    </html>
  );
}
