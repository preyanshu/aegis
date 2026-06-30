import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BlindMarket",
  description: "Private multi-market prediction markets on Stellar testnet",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
