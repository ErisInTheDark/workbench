/*
 * Default export:
 * - WorkbenchReactScanSetting: render and persist this device's React Scan opt-in, applied on the next page load.
 */
"use client";

import { useState } from "react";

import { readReactScanPreference, writeReactScanPreference } from "../../workbench/app/react-scan-preference";
import { OptionCard } from "../ui/OptionCards";

function boundedError(error: unknown) {
  return (error instanceof Error ? error.message : "Unable to save the React Scan preference.").slice(0, 500);
}

export default function WorkbenchReactScanSetting() {
  // What this page booted with; the saved choice applies on reload.
  const [loaded] = useState(() => readReactScanPreference());
  const [requested, setRequested] = useState(loaded);
  const [error, setError] = useState("");

  function toggle() {
    try {
      writeReactScanPreference(!requested);
      setRequested(!requested);
      setError("");
    } catch (failure) {
      setError(boundedError(failure));
    }
  }

  const description = requested !== loaded
    ? `React Scan is ${requested ? "on" : "off"} for this device. Reload the page to apply it.`
    : requested
      ? "React Scan highlights renders on this device. It adds render overhead; React development mode gives readable component names."
      : "Highlight React renders on this device. Off by default because it adds render overhead.";

  return (
    <section className="space-y-2 rounded-[0.85rem] py-1">
      <OptionCard
        description={description}
        isChecked={requested}
        isSingleChoice={false}
        label="React Scan"
        onClick={toggle}
      />
      {error ? <p className="m-0 text-[0.78rem] leading-5 text-danger" role="alert">{error}</p> : null}
    </section>
  );
}
