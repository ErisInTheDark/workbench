"use client";

import dynamic from "next/dynamic";

const Workbench = dynamic(() => import("./Workbench"), {
  ssr: false,
  loading: () => <div className="min-h-screen" suppressHydrationWarning />,
});

export default function WorkbenchPage() {
  return <Workbench />;
}
