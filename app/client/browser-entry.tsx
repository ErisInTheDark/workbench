/*
 * No exports. Browser entry installs diagnostics and opt-in React Scan before loading and rendering the standalone Workbench browser shell.
 */
import WorkbenchBrowserLogForwarder from "./WorkbenchBrowserLogForwarder.ts";
import frontendJavaScriptGeneration, {
  WORKBENCH_STYLESHEET_GENERATION_PROPERTY,
} from "workbench-shared/frontend-generation";

import { readReactScanPreference } from "./workbench/app/react-scan-preference.ts";

const logForwarder = new WorkbenchBrowserLogForwarder();
logForwarder.install();

function isReactScanRequested() {
  // Embedded agent thread views never profile.
  if (window.location.pathname.startsWith("/agent/thread")) return false;
  try {
    return readReactScanPreference();
  } catch (error) {
    console.warn("React Scan preference is unreadable; starting without it.", (error instanceof Error ? error.message : String(error)).slice(0, 300));
    return false;
  }
}

async function start() {
  // React Scan installs the devtools hook React DOM registers with at load, so it must load first.
  const reactScan = isReactScanRequested() ? await import("react-scan") : null;
  const [
    { createRoot },
    { default: WorkbenchAppBootstrap },
    { installBrowserNavigationEvents },
    { default: WorkbenchBrowserApp },
  ] = await Promise.all([
    import("react-dom/client"),
    import("./workbench/app/WorkbenchAppBootstrap.ts"),
    import("./workbench/navigation/browser-navigation.ts"),
    import("./WorkbenchBrowserApp.tsx"),
  ]);
  installBrowserNavigationEvents();
  const rootElement = document.getElementById("root");
  if (!rootElement) throw new Error("Workbench app root is unavailable.");
  const stylesheetGeneration = getComputedStyle(document.documentElement)
    .getPropertyValue(WORKBENCH_STYLESHEET_GENERATION_PROPERTY)
    .trim();
  const app = new WorkbenchAppBootstrap({
      loadedFrontendGeneration: frontendJavaScriptGeneration === "unbundled" || !stylesheetGeneration
        ? null
        : {
            javascript: frontendJavaScriptGeneration,
            stylesheet: stylesheetGeneration,
          },
  });
    document.documentElement.dataset.workbenchTheme = "default";
    window.addEventListener("pagehide", () => {
      app.dispose();
      logForwarder.dispose();
    }, { once: true });
    reactScan?.scan({ enabled: true, showNotificationCount: false });
    createRoot(rootElement).render(
      <WorkbenchBrowserApp controller={app.state} runtime={app.runtime} rpc={app.rpc} workspace={app.workspace} />,
    );
  app.start();
}

void start();
