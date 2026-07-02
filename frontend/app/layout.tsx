import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { getAppConfig } from "@/lib/server-config";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Aegis | Private Prediction Markets on Stellar",
  description: "An agentic private prediction market demo built for Stellar ZK: Reflector-fed conditions, autonomous traders, and proof-verifiable settlement flow.",
  icons: {
    icon: [
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
  },
  manifest: '/site.webmanifest',
};

import Providers from "@/components/Providers";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const browserConfig = JSON.stringify(getAppConfig()).replace(/</g, "\\u003c");

  return (
    <html lang="en">
      <body
        className={`${inter.variable} font-sans antialiased`}
      >
        <script
          dangerouslySetInnerHTML={{
            __html: `window.__BLIND_MARKET_CONFIG__ = ${browserConfig};`,
          }}
        />
        <Providers>
          {children}
        </Providers>
      </body>
    </html>
  );
}
