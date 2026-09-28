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
    { default: WorkbenchAppBootstrap },
    { installBrowserNavigationEvents },
    { default: WorkbenchBrowserApp },
  ] = await Promise.all([
    import("react-dom/client"),
    import("./components/ReactScan.tsx"),
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
    createRoot(rootElement).render(
      <>
        <ReactScan />
        <WorkbenchBrowserApp controller={app.state} runtime={app.runtime} rpc={app.rpc} workspace={app.workspace} />
      </>,
    );
  app.start();
}

void start();
