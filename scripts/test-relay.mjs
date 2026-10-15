/*
 * No exports. Execute Linux relay owner tests with the build command's isolated toolchain environment.
 */
import { relaySidecar } from "./build-relay.mjs";
import { readGoOption, runSidecarGo } from "./native-sidecar-build.mjs";

const go = readGoOption();
await runSidecarGo(relaySidecar, ["vet", "-mod=readonly", "./..."], go, { GOOS: "linux" });
await runSidecarGo(relaySidecar, ["test", "-mod=readonly", "-count=1", "./..."], go);
