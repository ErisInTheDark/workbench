/*
 * Exports:
 * - default WorkbenchAccountName: masked account label with explicit reveal; identity changes reset disclosure.
 */
"use client";

import { useState } from "react";
import type { AccountName } from "../../workbench/account-name";
import IconButton from "../ui/IconButton";
import { EyeIcon, EyeOffIcon } from "./workbench-icons";

type Props = { name: AccountName; className?: string };

function AccountNameValue({ name, className = "" }: Props) {
  const [revealed, setRevealed] = useState(false);
  const masked = name.short !== name.full;
  return <span className={`inline-flex min-w-0 max-w-full items-center gap-1 align-middle ${className}`}>
    <span className="truncate">{revealed ? name.full : name.short}</span>
    {masked ? <IconButton aria-pressed={revealed} display="hover-border" size="compact"
      label={revealed ? "Hide account" : "Show account"} onClick={() => setRevealed(!revealed)}>
      {revealed ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
    </IconButton> : null}
  </span>;
}

export default function WorkbenchAccountName(props: Props) {
  return <AccountNameValue key={props.name.full} {...props} />;
}
