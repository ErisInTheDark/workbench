import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "./globals.css";

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

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
