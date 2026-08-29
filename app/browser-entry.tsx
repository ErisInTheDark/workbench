/*
 * No exports. Browser entry installs route events, mounts React Scan, and renders the standalone Workbench browser shell.
 */
import { createRoot } from "react-dom/client";

import { ReactScan } from "../webapp/components/ReactScan.tsx";
import { installBrowserNavigationEvents } from "./browser-navigation.ts";
import WorkbenchBrowserApp from "./WorkbenchBrowserApp.tsx";

installBrowserNavigationEvents();

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Workbench app root is unavailable.");

createRoot(rootElement).render(
  <>
    <ReactScan />
    <WorkbenchBrowserApp />
  </>,
);
