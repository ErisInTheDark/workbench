/*
 * Exports:
 * - metadata: root document metadata for the standalone-capable Workbench app. Keywords: metadata, title, icons, iOS, standalone.
 * - viewport: root viewport settings for responsive Workbench rendering and color-scheme chrome. Keywords: viewport, mobile, theme.
 * - default RootLayout: application document shell with early theme bootstrap. Keywords: layout, theme, bootstrap.
 */
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { ReactScan } from "../components/ReactScan";
import "./globals.css";

const THEME_BOOTSTRAP_SCRIPT = `
try {
  var theme = window.localStorage.getItem("workbench:theme");
  document.documentElement.dataset.workbenchTheme = theme === "magical-girl" || theme === "winter" ? theme : "default";
} catch {
  document.documentElement.dataset.workbenchTheme = "default";
}
`;

export const metadata: Metadata = {
  title: "Workbench",
  description: "Minimal project file explorer and WYSIWYG markdown editor.",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Workbench",
  },
  icons: {
    apple: [{ url: "/icon", sizes: "512x512", type: "image/png" }],
    icon: [{ url: "/icon", sizes: "512x512", type: "image/png" }],
    shortcut: "/tab-icons/default.png",
  },
  formatDetection: {
    address: false,
    date: false,
    email: false,
    telephone: false,
  },
};

export const viewport: Viewport = {
  initialScale: 1,
  maximumScale: 1,
  themeColor: [
    { color: "#f7f8fb", media: "(prefers-color-scheme: light)" },
    { color: "#10131a", media: "(prefers-color-scheme: dark)" },
  ],
  userScalable: false,
  width: "device-width",
};

export default function RootLayout ({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <ReactScan />
      <body suppressHydrationWarning>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
        {children}
      </body>
    </html>
  );
}
