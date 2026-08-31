/*
 * No exports. Browser entry installs diagnostics before loading and rendering the standalone Workbench browser shell.
 */
import WorkbenchBrowserLogForwarder from "./WorkbenchBrowserLogForwarder.ts";

const logForwarder = new WorkbenchBrowserLogForwarder();
logForwarder.install();

async function start() {
  const [
    { createRoot },
    { ReactScan },
    { default: WorkbenchClientStateController },
    { default: WorkbenchAppRuntimeClient },
    { installBrowserNavigationEvents },
    { default: WorkbenchBrowserApp },
  ] = await Promise.all([
    import("react-dom/client"),
    import("../webapp/components/ReactScan.tsx"),
    import("../webapp/lib/workbench/state/WorkbenchClientStateController.ts"),
    import("../webapp/lib/workbench/app/WorkbenchAppRuntimeClient.ts"),
    import("../webapp/lib/workbench/navigation/browser-navigation.ts"),
    import("./WorkbenchBrowserApp.tsx"),
  ]);
  installBrowserNavigationEvents();
  const rootElement = document.getElementById("root");
  if (!rootElement) throw new Error("Workbench app root is unavailable.");
  const controller = new WorkbenchClientStateController({ mode: "http" });
  const runtime = new WorkbenchAppRuntimeClient();
  try {
    await Promise.all([controller.bootstrap(), runtime.bootstrap()]);
    const theme = controller.records("globalPreference").find((record) => (
      record.preference.key === "theme"
    ))?.preference.value;
    document.documentElement.dataset.workbenchTheme = theme === "magical-girl" || theme === "winter"
      ? theme
      : "default";
    window.addEventListener("pagehide", () => {
      controller.dispose();
      runtime.dispose();
      logForwarder.dispose();
    }, { once: true });
    createRoot(rootElement).render(
      <>
        <ReactScan />
        <WorkbenchBrowserApp controller={controller} runtime={runtime} />
      </>,
    );
  } catch (error) {
    controller.dispose();
    runtime.dispose();
    document.documentElement.dataset.workbenchTheme = "default";
    rootElement.textContent = error instanceof Error
      ? `Workbench could not load its app state: ${error.message}`
      : "Workbench could not load its app state.";
  }
}

void start();
