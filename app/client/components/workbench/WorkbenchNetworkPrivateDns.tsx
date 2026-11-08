/*
 * Exports:
 * - default WorkbenchNetworkPrivateDns: whether private names resolve, the one change to make next, and every computer
 *   with its nameserver address, whether Tailscale DNS lists it and whether it is running.
 */
"use client";
import { TAILSCALE_DNS_ADMIN_URL, type NetworkDnsCoverage } from "../../workbench/app/network-dns-coverage";
import SettingsCard, { SettingsCardRow } from "../ui/SettingsCard";
import LoaderIcon from "./LoaderIcon";
import WorkbenchCopyButton from "./WorkbenchCopyButton";
import WorkbenchLinkButton from "./WorkbenchLinkButton";
import { CheckIcon, ExternalLinkIcon, TriangleAlertIcon, XIcon } from "./workbench-icons";

const COLUMNS = "grid w-full grid-cols-[minmax(6rem,9rem)_1fr_minmax(6rem,9rem)_minmax(4rem,6rem)] items-center gap-x-3 text-sm";

function headline(coverage: NetworkDnsCoverage | null) {
  if (!coverage) return { tone: "text-fg/muted", Icon: LoaderIcon, title: "Checking Tailscale DNS...", next: null };
  const add = coverage.suggestion ? `Add ${coverage.suggestion.label} as a nameserver for wb.inthedark.boo in Tailscale DNS.` : null;
  const tidy = coverage.rows.some(row => row.listed && (!row.label || row.online === false))
    ? "Remove the offline or unknown entries from Tailscale DNS." : null;
  if (coverage.verdict === "healthy") return { tone: "text-success", Icon: CheckIcon, title: "Private names work", next: null };
  if (coverage.verdict === "broken") {
    return { tone: "text-danger", Icon: XIcon, title: "Private names don't resolve", next: add ?? "Start a Workbench computer and add it as a nameserver in Tailscale DNS." };
  }
  return { tone: "text-[color:var(--attention)]", Icon: TriangleAlertIcon, title: "Works, but one outage away",
    next: add ?? tidy ?? "Start a second Workbench computer and add it as a nameserver in Tailscale DNS." };
}

export default function WorkbenchNetworkPrivateDns({ coverage }: { coverage: NetworkDnsCoverage | null }) {
  const head = headline(coverage);
  return <SettingsCard label="Private DNS">
    <SettingsCardRow>
      <div role="status" className="flex w-full items-start gap-3">
        <head.Icon size={20} className={`mt-0.5 size-5 shrink-0 ${head.tone}`} />
        <div className="min-w-0 flex-1">
          <p className={`m-0 font-semibold ${head.tone}`}>{head.title}</p>
          {head.next ? <p className="m-0 text-sm text-fg/muted">{head.next}</p> : null}
        </div>
        {coverage && coverage.verdict !== "healthy"
          ? <WorkbenchLinkButton href={TAILSCALE_DNS_ADMIN_URL} target="_blank" rel="noreferrer">Open Tailscale DNS<ExternalLinkIcon className="size-4" /></WorkbenchLinkButton>
          : null}
      </div>
    </SettingsCardRow>
    {coverage ? <SettingsCardRow>
      <div className={`${COLUMNS} text-fg/muted`}><span>Computer</span><span>Nameserver address</span><span>In Tailscale DNS</span><span>Running</span></div>
    </SettingsCardRow> : null}
    {coverage?.rows.map(row => <SettingsCardRow key={row.address}>
      <div className={COLUMNS}>
        <span className={`truncate ${row.label ? "text-text" : "text-fg/muted"}`}>{row.label ?? "Not a Workbench computer"}</span>
        <span className="flex min-w-0 items-center gap-1">
          <code className="truncate text-text">{row.address}</code>
          {!row.listed && row.online ? <WorkbenchCopyButton label={`Copy ${row.label} nameserver address`} text={row.address} /> : null}
        </span>
        <span className={`flex items-center gap-1 ${!row.label ? "text-[color:var(--attention)]" : row.listed ? "text-success" : "text-fg/muted"}`}>
          {!row.label ? <><TriangleAlertIcon className="size-4" />Yes, remove it</> : row.listed ? <><CheckIcon className="size-4" />Yes</> : "No"}
        </span>
        <span className={row.online ? "text-success" : "text-fg/muted"}>{row.online === null ? "Unknown" : row.online ? "Online" : "Offline"}</span>
      </div>
    </SettingsCardRow>)}
  </SettingsCard>;
}
