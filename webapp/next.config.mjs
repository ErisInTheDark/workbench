/*
 * Exports:
 * - default nextConfig: Next.js development and bundler configuration. Keywords: next, config, dev origins, turbopack, source maps.
 *
 * Helpers:
 * - createAllowedDevOrigins: collect loopback, local interface, and env-configured dev origins for Next.js. Keywords: allowedDevOrigins, mobile, LAN.
 * - readNetworkInterfaceDevOrigins: list non-internal IPv4 interface addresses reachable by local mobile browsers. Keywords: network interfaces, IPv4.
 * - readEnvAllowedDevOrigins: parse comma-separated extra dev origins from NEXT_ALLOWED_DEV_ORIGINS. Keywords: env, custom hosts.
 * - toDevtoolsFileUrl: map devtool module paths to file URLs for browser source maps. Keywords: devtools, source maps.
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appDirectory = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_ALLOWED_DEV_ORIGINS = [
  "127.0.0.1",
  "localhost",
];

function readNetworkInterfaceDevOrigins() {
  const origins = [];

  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) {
        continue;
      }

      origins.push(address.address);
    }
  }

  return origins;
}

function readEnvAllowedDevOrigins() {
  return (process.env.NEXT_ALLOWED_DEV_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function createAllowedDevOrigins() {
  return Array.from(new Set([
    ...DEFAULT_ALLOWED_DEV_ORIGINS,
    ...readNetworkInterfaceDevOrigins(),
    ...readEnvAllowedDevOrigins(),
  ]));
}

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
  allowedDevOrigins: createAllowedDevOrigins(),
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
