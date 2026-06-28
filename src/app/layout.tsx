import type { Metadata, Viewport } from "next";
import "./globals.css";

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
  themeColor: "#0a0e0a",
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
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
