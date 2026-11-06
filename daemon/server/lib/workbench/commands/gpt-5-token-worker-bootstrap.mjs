import { register } from "tsx/esm/api";

register();

await import("./gpt-5-token-worker.ts");
