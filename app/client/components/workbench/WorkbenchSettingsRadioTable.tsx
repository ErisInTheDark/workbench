/*
 * Exports:
 * - default WorkbenchSettingsRadioTable: compact flush table of related select settings, one radio row per setting.
 */
"use client";

import type { LogicalProjectId } from "workbench-shared/workbench/identity";
import { WORKBENCH_SETTING_DEFINITIONS, type WorkbenchSettingKey } from "../../workbench/state/workbench-settings";
import IconButton from "../ui/IconButton";
import RadioRow from "../ui/RadioRow";
import { useSettings } from "./use-settings";
import { ResetIcon } from "./workbench-icons";

export default function WorkbenchSettingsRadioTable({
  description,
  keys,
  logicalProjectId,
  onError,
  title,
}: {
  description?: string;
  keys: readonly WorkbenchSettingKey[];
  logicalProjectId: LogicalProjectId | null;
  onError: (message: string) => void;
  /** Heading for a group of related rows; a single self-describing row needs none. */
  title?: string;
}) {
  const settings = useSettings(logicalProjectId);
  const report = (error: Error) => onError(error.message);
  const unavailable = keys.some(key => settings.unavailable(key));
  return (
    <section className="space-y-2 py-3">
      {title ? <div>
        <h3 className="m-0 text-sm font-semibold text-text">{title}</h3>
        {description ? <p className="m-0 mt-1 text-detail text-fg/muted">{description}</p> : null}
      </div> : null}
      <table className="w-full border-collapse text-sm">
        <tbody>
          {keys.map(key => {
            const definition = WORKBENCH_SETTING_DEFINITIONS[key];
            const value = settings.get(key);
            return (
              <tr key={key} className="border-t border-fg/6 first:border-t-0">
                <th scope="row" className="py-2 pr-4 text-left align-middle font-medium text-text">
                  {definition.label}
                  <span className="block text-detail font-normal text-fg/muted">{definition.description}</span>
                </th>
                <td className="w-0 whitespace-nowrap py-2 text-right align-middle">
                  <span className="inline-flex items-center gap-1">
                    <RadioRow<string>
                      ariaLabel={title ? `${title}: ${definition.label}` : definition.label}
                      size="comfortable"
                      disabled={unavailable}
                      onChange={next => { void settings.set(key, next as never).catch(report); }}
                      options={(definition.options ?? []).map(option => ({
                        label: option.label, title: option.description, value: String(option.value),
                      }))}
                      value={String(value)}
                    />
                    {settings.overridden(key) ? (
                      <IconButton type="button" display="hover-border" size="small" disabled={unavailable}
                        label={`Reset ${definition.label} to global`} onClick={() => { void settings.reset(key).catch(report); }}>
                        <ResetIcon size={16} />
                      </IconButton>
                    ) : null}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {unavailable ? <p className="m-0 text-xs text-fg/muted">Available after the app database is reloaded.</p> : null}
    </section>
  );
}
