import { register } from "tsx/esm/api";

register();

await import("./ripgrep-worker.ts");
