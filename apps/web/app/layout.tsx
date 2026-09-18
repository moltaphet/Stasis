import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

export const metadata: Metadata = {
  title: "STASIS PROTOCOL - Autonomous Security Terminal",
  description:
    "Deterministic pause protocol for autonomous finance. Multi-LLM consensus and dual-feed telemetry trip a verifiable on-chain circuit breaker inside the transaction window.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable} dark`}
    >
      <body className="min-h-screen font-sans antialiased">{children}</body>
    </html>
  );
}
