import type { Metadata } from "next";
import { Spectral, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const serif = Spectral({
  variable: "--font-spectral",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  style: ["normal", "italic"],
  display: "swap",
});

const mono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://pacioliapp.vercel.app"),
  title: {
    default: "Pacioli — Did your AI actually do what it said?",
    template: "%s · Pacioli",
  },
  description:
    "Double-entry bookkeeping for AI agents. Pacioli reconciles what your agent claimed it did against what the evidence shows — and flags overspend, unauthorized subscriptions, and scope creep.",
  openGraph: {
    title: "Pacioli — Did your AI actually do what it said?",
    description:
      "Paste an agent's claim and a confirmation. Get a receipt that reconciles claimed vs actual — and shows whether the books balance.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${serif.variable} ${mono.variable} h-full antialiased`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
