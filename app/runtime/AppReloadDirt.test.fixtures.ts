/*
 * Exports:
 * - APP_RELOAD_DIRT_FIXTURE: committed app/shared/static/tray sources and ignored runtime boundary.
 */
import type { GitTestFixtureSpec } from "../../daemon/lib/workbench/git/GitTestFixtureCache";

export const APP_RELOAD_DIRT_FIXTURE = {
  name: "app-reload-dirt",
  commits: [{
    files: {
      ".gitignore": ".workbench/\n",
      "app/runtime/http.ts": "export const http = 1;\n",
      "shared/owner.ts": "export const shared = 1;\n",
      "static/index.html": "<main>app</main>\n",
      "tray/src/main.rs": "fn main() {}\n",
      "tray/target/ignored.exe": "ignored\n",
    },
    message: "initial",
  }],
} satisfies GitTestFixtureSpec;
