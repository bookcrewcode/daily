import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Newsreader } from "next/font/google";
import "./globals.css";

// Geist + Geist Mono (Vercel's instrument pair) — self-hosted at build time by
// next/font, zero runtime requests. Mono carries every number in the app.
// Newsreader stays as the Learning "study desk" editorial serif.
const reading = Newsreader({ subsets: ["latin"], variable: "--font-reading", weight: ["400", "500", "600"], style: ["normal", "italic"] });

export const metadata: Metadata = {
  title: "Daily",
  description: "Ben's daily win stack — tap, log, stay consistent.",
  // basePath is NOT auto-applied to these metadata links on static export,
  // so the /daily prefix is hardcoded to resolve on GitHub Pages.
  manifest: "/daily/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Daily",
  },
  icons: {
    apple: "/daily/icons/apple-touch-icon.png",
    icon: "/daily/icons/icon-192.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#07080a",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`h-full antialiased ${GeistSans.variable} ${GeistMono.variable} ${reading.variable}`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
