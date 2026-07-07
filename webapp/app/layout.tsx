/*
 * Exports:
 * - metadata: root document metadata for the Workbench app. Keywords: metadata, title, icons.
 * - viewport: root viewport settings for responsive Workbench rendering. Keywords: viewport, mobile.
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
  icons: {
    icon: "/tab-icons/default.png",
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
