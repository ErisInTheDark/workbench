/*
 * No exports. Execute network owner tests with the build command's isolated toolchain environment.
 */
import { runNetworkGo } from "./build-network.mjs";

const index = process.argv.indexOf("--go");
await runNetworkGo(["test", "-mod=readonly", "-count=1", "./..."], index < 0 ? undefined : process.argv[index + 1]);
