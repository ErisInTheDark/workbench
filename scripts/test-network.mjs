/*
 * No exports. Execute network owner tests with the build command's isolated toolchain environment.
 */
import { networkSidecar } from "./build-network.mjs";
import { readGoOption, runSidecarGo } from "./native-sidecar-build.mjs";

await runSidecarGo(networkSidecar, ["test", "-mod=readonly", "-count=1", "./..."], readGoOption());
