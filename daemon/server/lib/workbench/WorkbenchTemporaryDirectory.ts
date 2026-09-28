/*
 * Exports:
 * - WORKBENCH_TEMPORARY_ROOT_ENV: child-process override for a validated directory inside this Workbench project's temp root. Keywords: temp, environment, tests.
 * - default WorkbenchTemporaryDirectory: resolve, create, and dispose Workbench-owned temporary directories under this project's `.workbench/tmp`. Keywords: temp, lifecycle, cleanup, project.
 */
import WorkbenchTemporaryDirectory, { WORKBENCH_TEMPORARY_ROOT_ENV } from "workbench-shared/WorkbenchTemporaryDirectory";

export { WORKBENCH_TEMPORARY_ROOT_ENV };
export default WorkbenchTemporaryDirectory;
