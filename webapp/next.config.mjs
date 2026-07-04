import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appDirectory = fileURLToPath(new URL(".", import.meta.url));

function toDevtoolsFileUrl (info) {
  const resourcePath = typeof info.absoluteResourcePath === "string" && info.absoluteResourcePath
    ? info.absoluteResourcePath
    : typeof info.resourcePath === "string" && info.resourcePath
      ? path.resolve(appDirectory, info.resourcePath)
      : "";

  if (!resourcePath) {
    const fallbackId = typeof info.identifier === "string" && info.identifier ? info.identifier : "unknown-module";
    return `webpack:///${fallbackId}`;
  }

  return pathToFileURL(resourcePath).href;
}

/** @type {import("next").NextConfig} */
const nextConfig = {
  turbopack: {},
  webpack (config, { dev, isServer }) {
    if (!dev || isServer) {
      return config;
    }

    config.output ??= {};
    config.output.devtoolModuleFilenameTemplate = toDevtoolsFileUrl;
    config.output.devtoolFallbackModuleFilenameTemplate = toDevtoolsFileUrl;

    for (const plugin of config.plugins ?? []) {
      if (plugin?.constructor?.name !== "EvalSourceMapDevToolPlugin") {
        continue;
      }

      plugin.moduleFilenameTemplate = toDevtoolsFileUrl;
      if (plugin.options) {
        plugin.options.moduleFilenameTemplate = toDevtoolsFileUrl;
      }
    }

    return config;
  },
};

export default nextConfig;
