/*
 * Default export:
 * - WorkbenchCertificateTrust: render one local host's safest certificate trust action.
 */
"use client";
import { useState } from "react";
import { writeTextToClipboard } from "../../workbench/dom/clipboard";
import PrimaryButton from "../ui/PrimaryButton";
import WorkbenchLinkButton from "./WorkbenchLinkButton";
import { LockIcon } from "./workbench-icons";

const CERTIFICATE_BOUNDARY = "WORKBENCH_PRIVATE_ROOT_CERTIFICATE";

function updateCaCertificatesCommand(certificate: string) {
  return `sudo tee /usr/local/share/ca-certificates/workbench-private-root.crt >/dev/null <<'${CERTIFICATE_BOUNDARY}' &&
${certificate.trim()}
${CERTIFICATE_BOUNDARY}
sudo update-ca-certificates`;
}

function p11KitTrustCommand(certificate: string) {
  return `(
  set -eu
  workbench_private_root="$(mktemp)"
  trap 'rm -f "$workbench_private_root"' EXIT
  cat >"$workbench_private_root" <<'${CERTIFICATE_BOUNDARY}'
${certificate.trim()}
${CERTIFICATE_BOUNDARY}
  sudo trust anchor --store "$workbench_private_root"
)`;
}

function nixosTrustModule(certificate: string) {
  const encoded = certificate.trim().split(/\r?\n/u).map(line => `    ${line}`).join("\n");
  return `# Import this module, rebuild NixOS, restart the browser, then retry HTTPS in Workbench.
{ ... }:
let
  workbenchPrivateRoot = builtins.toFile "workbench-private-root.crt" ''
${encoded}
  '';
in {
  security.pki.certificateFiles = [ workbenchPrivateRoot ];
  programs.firefox.policies.Certificates.Install = [
    "\${workbenchPrivateRoot}"
  ];
}
`;
}

export default function WorkbenchCertificateTrust({
  busy,
  certificate,
  enabled,
  hostPlatform,
  onCopyFailure,
  onTrust,
}: {
  busy: boolean;
  certificate: string;
  enabled: boolean;
  hostPlatform: string;
  onCopyFailure: () => void;
  onTrust: () => void;
}) {
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  if (!enabled) return null;
  if (hostPlatform === "win32") {
    return <PrimaryButton disabled={busy} onClick={onTrust}>
      <LockIcon className="mr-2 size-4" />Trust certificate on this PC
    </PrimaryButton>;
  }
  if (hostPlatform === "linux:nixos") {
    return <WorkbenchLinkButton
      download="workbench-private-root.nix"
      href={`data:text/plain;charset=utf-8,${encodeURIComponent(nixosTrustModule(certificate))}`}>
      Download NixOS trust module
    </WorkbenchLinkButton>;
  }
  const command = hostPlatform === "linux:update-ca-certificates"
    ? updateCaCertificatesCommand(certificate)
    : hostPlatform === "linux:p11-kit" ? p11KitTrustCommand(certificate) : null;
  if (!command) return null;
  return <PrimaryButton disabled={busy} onClick={() => {
    void writeTextToClipboard(command)
      .then(copied => {
        if (copied) setCopiedCommand(command);
        else { setCopiedCommand(null); onCopyFailure(); }
      })
      .catch(() => { setCopiedCommand(null); onCopyFailure(); });
  }}>
    <LockIcon className="mr-2 size-4" />{copiedCommand === command ? "Copied" : "Copy"} certificate install command
  </PrimaryButton>;
}
