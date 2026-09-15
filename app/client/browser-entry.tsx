/*
 * No exports. Browser entry installs diagnostics before loading and rendering the standalone Workbench browser shell.
 */
import WorkbenchBrowserLogForwarder from "./WorkbenchBrowserLogForwarder.ts";
import frontendJavaScriptGeneration, {
  WORKBENCH_STYLESHEET_GENERATION_PROPERTY,
} from "workbench-shared/frontend-generation";

const logForwarder = new WorkbenchBrowserLogForwarder();
logForwarder.install();

async function start() {
  const [
    { createRoot },
    { ReactScan },
    { default: WorkbenchClientStateController },
    { default: WorkbenchAppRuntimeClient },
    { readWorkbenchAppPort },
    { resolveWorkbenchBrowserStateIdentity },
    { installBrowserNavigationEvents },
    { default: WorkbenchBrowserApp },
  ] = await Promise.all([
    import("react-dom/client"),
    import("./components/ReactScan.tsx"),
    import("./workbench/state/WorkbenchClientStateController.ts"),
    import("./workbench/app/WorkbenchAppRuntimeClient.ts"),
    import("./workbench/app/workbench-app-port-client.ts"),
    import("./workbench/state/workbench-browser-state-identity.ts"),
    import("./workbench/navigation/browser-navigation.ts"),
    import("./WorkbenchBrowserApp.tsx"),
  ]);
  installBrowserNavigationEvents();
  const rootElement = document.getElementById("root");
  if (!rootElement) throw new Error("Workbench app root is unavailable.");
  const stylesheetGeneration = getComputedStyle(document.documentElement)
    .getPropertyValue(WORKBENCH_STYLESHEET_GENERATION_PROPERTY)
    .trim();
  const runtime = new WorkbenchAppRuntimeClient({
    loadedFrontendGeneration: frontendJavaScriptGeneration === "unbundled" || !stylesheetGeneration
      ? null
      : {
          javascript: frontendJavaScriptGeneration,
          stylesheet: stylesheetGeneration,
        },
  });
  let controller: InstanceType<typeof WorkbenchClientStateController> | null = null;
  try {
    const portSnapshot = await readWorkbenchAppPort();
    const identity = resolveWorkbenchBrowserStateIdentity(portSnapshot);
    if (identity.cleanedHref) window.history.replaceState(window.history.state, "", identity.cleanedHref);
    controller = new WorkbenchClientStateController({
      browserStateId: identity.browserStateId,
      mode: "http",
    });
    const activeController = controller;
    await Promise.all([activeController.bootstrap(), runtime.bootstrap()]);
    const theme = activeController.records("globalPreference").find((record) => (
      record.preference.key === "theme"
    ))?.preference.value;
    document.documentElement.dataset.workbenchTheme = theme === "magical-girl" || theme === "winter"
      ? theme
      : "default";
    window.addEventListener("pagehide", () => {
      activeController.dispose();
      runtime.dispose();
      logForwarder.dispose();
    }, { once: true });
    createRoot(rootElement).render(
      <>
        <ReactScan />
        <WorkbenchBrowserApp controller={activeController} runtime={runtime} />
      </>,
    );
  } catch (error) {
    controller?.dispose();
    runtime.dispose();
    document.documentElement.dataset.workbenchTheme = "default";
    rootElement.textContent = error instanceof Error
      ? `Workbench could not load its app state: ${error.message}`
      : "Workbench could not load its app state.";
  }
}

void start();
