/*
 * Exports:
 * - ProviderKeyTarget: the integration and key method a key form connects.
 * - default ProviderSignInPanel: a provider row's body: the pending sign-in link, code and paste box, a key form, and other integrations.
 */
"use client";

import { useState } from "react";
import type { ProviderAccountIntegration, ProviderSignInAttempt } from "workbench-shared/workbench/provider/provider-account-sign-in";
import type ProviderAccountController from "../../workbench/ProviderAccountController";
import Disclosure from "../ui/Disclosure";
import PrimaryButton from "../ui/PrimaryButton";
import { IconLabel } from "./settings-row-labels";
import WorkbenchCopyButton from "./WorkbenchCopyButton";
import WorkbenchTextField from "./WorkbenchTextField";
import { ExternalLinkIcon } from "./workbench-icons";

export interface ProviderKeyTarget { integrationId: string; methodId: string; label: string }

type Props = { provider: string; controller: ProviderAccountController; busy: boolean };

const section = "mt-2.5 flex flex-col gap-2 border-t border-fg/8 pt-2.5 text-[0.82em]";
const linkClassName = "inline-flex items-center rounded-full bg-fg/6 px-3 py-1.5 text-[0.76rem] text-text hover:bg-fg/10";

function PendingAttempt({ provider, controller, busy, attempt }: Props & { attempt: ProviderSignInAttempt }) {
  const [code, setCode] = useState("");
  return <div className={section}>
    <p className="m-0 text-fg/muted">
      {attempt.userCode ? "Open the sign-in page on any device and enter this code." : "Open the sign-in page on any device."}
      {" "}This row updates once you finish.
    </p>
    <div className="flex flex-wrap items-center gap-2">
      <a className={linkClassName} href={attempt.url} target="_blank" rel="noreferrer">
        <IconLabel icon={<ExternalLinkIcon size={14} />}>Open sign-in page</IconLabel>
      </a>
      {attempt.userCode ? <span className="inline-flex items-center gap-1">
        <code className="rounded-md bg-fg/6 px-2 py-1 font-mono text-[0.95em] tracking-wider text-text">{attempt.userCode}</code>
        <WorkbenchCopyButton text={attempt.userCode} label="Copy sign-in code" />
      </span> : null}
      <PrimaryButton shape="compact" disabled={busy} onClick={() => { void controller.cancel(provider, attempt.id); }}>Cancel</PrimaryButton>
    </div>
    {attempt.acceptsCode ? <form className="flex flex-wrap items-center gap-2" onSubmit={event => {
      event.preventDefault();
      void controller.submitCode(provider, attempt.id, code.trim()).then(sent => { if (sent) setCode(""); });
    }}>
      <WorkbenchTextField variant="dotted" className="min-w-0 flex-1 font-mono" aria-label="Sign-in code"
        placeholder="Paste the code if the page shows one" autoComplete="off" spellCheck={false} disabled={busy}
        value={code} onChange={event => setCode(event.target.value)} />
      <PrimaryButton type="submit" shape="compact" disabled={busy || !code.trim()}>Submit</PrimaryButton>
    </form> : null}
  </div>;
}

function KeyForm({ provider, controller, busy, target, onDone }: Props & { target: ProviderKeyTarget; onDone: () => void }) {
  const [key, setKey] = useState("");
  return <form className={`${section} sm:flex-row sm:flex-wrap sm:items-center`} onSubmit={event => {
    event.preventDefault();
    void controller.start(provider, target.integrationId, target.methodId, key.trim()).then(saved => { if (saved) onDone(); });
  }}>
    <WorkbenchTextField variant="dotted" type="password" className="min-w-0 flex-1 font-mono" aria-label={target.label}
      placeholder={target.label} autoComplete="off" spellCheck={false} disabled={busy} value={key} onChange={event => setKey(event.target.value)} />
    <span className="flex items-center gap-2">
      <PrimaryButton type="submit" shape="compact" disabled={busy || !key.trim()}>Save</PrimaryButton>
      <PrimaryButton shape="compact" disabled={busy} onClick={onDone}>Cancel</PrimaryButton>
    </span>
  </form>;
}

/** Every non-primary integration as a compact connect/disconnect list. */
function OtherIntegrations({ provider, controller, busy, integrations, onKey }: Props & {
  integrations: ProviderAccountIntegration[];
  onKey: (target: ProviderKeyTarget) => void;
}) {
  return <Disclosure className="mt-2.5 border-t border-fg/8 pt-2" compactSummary stateId={`provider-integrations-${provider}`}
    summary={<span className="text-[0.8rem]">Other integrations</span>}>
    <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0 text-[0.82em]">
      {integrations.map(integration => <li key={integration.id} className="flex flex-wrap items-center gap-2 rounded-lg px-1 py-1">
        <span className="min-w-0 flex-1 text-text">
          {integration.label}
          {integration.signedIn ? <span className="ml-2 text-success">{integration.accountLabel ?? "Connected"}</span> : null}
        </span>
        {integration.signedIn
          ? <PrimaryButton shape="compact" disabled={busy} onClick={() => { void controller.signOut(provider, integration.id); }}>Disconnect</PrimaryButton>
          : integration.methods.map(method => <PrimaryButton key={method.id} shape="compact" disabled={busy} onClick={() => {
            if (method.kind === "key") onKey({ integrationId: integration.id, methodId: method.id, label: `${integration.label} ${method.label}` });
            else void controller.start(provider, integration.id, method.id);
          }}>{method.label}</PrimaryButton>)}
      </li>)}
    </ul>
  </Disclosure>;
}

export default function ProviderSignInPanel({ provider, controller, busy, attempt, integrations, keyTarget, onKey, onKeyDone }: Props & {
  attempt: ProviderSignInAttempt | null;
  /** Non-primary integrations; listed only when the provider has some. */
  integrations: ProviderAccountIntegration[];
  keyTarget: ProviderKeyTarget | null;
  onKey: (target: ProviderKeyTarget) => void;
  onKeyDone: () => void;
}) {
  const props = { provider, controller, busy };
  return <>
    {attempt?.state === "pending" ? <PendingAttempt {...props} attempt={attempt} /> : null}
    {keyTarget ? <KeyForm {...props} target={keyTarget} onDone={onKeyDone} /> : null}
    {integrations.length ? <OtherIntegrations {...props} integrations={integrations} onKey={onKey} /> : null}
  </>;
}
