/*
 * Exports:
 * - default manifest: declare Workbench as a standalone Home Screen web app launched through the last-project route. Keywords: workbench, manifest, standalone, iOS, launch, icon.
 */

import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    background_color: "#10131a",
    description: "A local workspace for projects and agent threads.",
    display: "standalone",
    icons: [{
      purpose: "maskable",
      sizes: "512x512",
      src: "/icon",
      type: "image/png",
    }],
    name: "Workbench",
    scope: "/",
    short_name: "Workbench",
    start_url: "/launch",
    theme_color: "#6d28d9",
  };
}
