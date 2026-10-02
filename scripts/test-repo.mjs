/*
 * No exports. Execute virtual repository owner tests with the build command's isolated toolchain environment.
 * Set WORKBENCH_REPO_LIVE=1 to include real filesystem mounts on this host.
 */
import { repoSidecar } from "./build-repo.mjs";
import { readGoOption, runSidecarGo } from "./native-sidecar-build.mjs";

const go = readGoOption();
await runSidecarGo(repoSidecar, ["vet", "-mod=readonly", "./..."], go, { GOOS: "linux" });
await runSidecarGo(repoSidecar, ["test", "-mod=readonly", "-count=1", "./..."], go);
