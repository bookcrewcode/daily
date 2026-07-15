import type { Metadata, Viewport } from "next";
import { Space_Grotesk, Inter } from "next/font/google";
import "./globals.css";

// self-hosted at build time by next/font — no external requests at runtime
const display = Space_Grotesk({ subsets: ["latin"], variable: "--font-display", weight: ["500", "600", "700"] });
const body = Inter({ subsets: ["latin"], variable: "--font-body" });

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
  themeColor: "#0a0a14",
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
    <html lang="en" className={`h-full antialiased ${display.variable} ${body.variable}`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
