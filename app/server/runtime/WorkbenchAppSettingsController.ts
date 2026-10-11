/*
 * Default export:
 * - WorkbenchAppSettingsController: own app-wide settings over shared state and process-applied values.
 */
import {
  WorkbenchAppSettingsUpdateRequestSchema,
  type WorkbenchAppSettingsSnapshot,
  type WorkbenchAppSettingsUpdateRequest,
} from "workbench-shared/http/workbench-app-settings";

export default class WorkbenchAppSettingsController {
  constructor(private readonly options: {
    readAppliedReactDevelopmentMode(): boolean;
    readRequestedReactDevelopmentMode(): boolean | null;
    sourceRootPath?: string;
    writeRequestedReactDevelopmentMode(value: boolean): Promise<void>;
  }) {}

  read(): WorkbenchAppSettingsSnapshot {
    return {
      appliedReactDevelopmentMode: this.options.readAppliedReactDevelopmentMode(),
      requestedReactDevelopmentMode: this.options.readRequestedReactDevelopmentMode() === true,
      ...(this.options.sourceRootPath ? { sourceRootPath: this.options.sourceRootPath } : {}),
    };
  }

  async update(value: WorkbenchAppSettingsUpdateRequest) {
    const input = WorkbenchAppSettingsUpdateRequestSchema.parse(value);
    await this.options.writeRequestedReactDevelopmentMode(input.reactDevelopmentMode);
    return this.read();
  }
}
