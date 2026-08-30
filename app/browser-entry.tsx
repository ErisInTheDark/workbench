/*
 * No exports. Browser entry installs route events, mounts React Scan, and renders the standalone Workbench browser shell.
 */
import { createRoot } from "react-dom/client";

import { ReactScan } from "../webapp/components/ReactScan.tsx";
import WorkbenchClientStateController from "../webapp/lib/workbench/state/WorkbenchClientStateController.ts";
import { installBrowserNavigationEvents } from "./browser-navigation.ts";
import WorkbenchBrowserApp from "./WorkbenchBrowserApp.tsx";

installBrowserNavigationEvents();

async function start() {
  const rootElement = document.getElementById("root");
  if (!rootElement) throw new Error("Workbench app root is unavailable.");
  const controller = new WorkbenchClientStateController({ mode: "http" });
  try {
    await controller.bootstrap();
    const theme = controller.records("globalPreference").find((record) => (
      record.preference.key === "theme"
    ))?.preference.value;
    document.documentElement.dataset.workbenchTheme = theme === "magical-girl" || theme === "winter"
      ? theme
      : "default";
    window.addEventListener("pagehide", () => controller.dispose(), { once: true });
    createRoot(rootElement).render(
      <>
        <ReactScan />
        <WorkbenchBrowserApp controller={controller} />
      </>,
    );
  } catch (error) {
    controller.dispose();
    document.documentElement.dataset.workbenchTheme = "default";
    rootElement.textContent = error instanceof Error
      ? `Workbench could not load its app state: ${error.message}`
      : "Workbench could not load its app state.";
  }
}

void start();
