/*
 * Default export:
 * - WorkbenchCertificateInstall: download the private root certificate with per-device install help.
 */
"use client";
import Disclosure from "../ui/Disclosure";
import WorkbenchLinkButton from "./WorkbenchLinkButton";
import { ExternalLinkIcon } from "./workbench-icons";

export default function WorkbenchCertificateInstall({ certificate }: { certificate: string }) {
  return <>
    <WorkbenchLinkButton download="workbench-private-root.crt" href={`data:application/x-x509-ca-cert,${encodeURIComponent(certificate)}`}>Download certificate</WorkbenchLinkButton>
    <Disclosure summary="How do I install it?" className="w-full text-sm text-fg/muted" contentClassName="flex flex-col items-start gap-2 pt-3">
      <p className="m-0">Trust is only needed once per browsing device. If this certificate is already trusted, check Tailscale connectivity and the nameserver entry instead of installing it again.</p>
      <p className="m-0">Open the downloaded certificate in your device's certificate settings and enable trust for websites. Only trust it if you recognise this Workbench network.</p>
      <p className="m-0">On another Windows PC, import it into your Current User &gt; Trusted Root Certification Authorities store.</p>
      <WorkbenchLinkButton href="https://learn.microsoft.com/en-us/windows-hardware/drivers/install/trusted-root-certification-authorities-certificate-store" target="_blank" rel="noreferrer">Windows certificate help<ExternalLinkIcon className="size-4" /></WorkbenchLinkButton>
      <WorkbenchLinkButton href="https://support.apple.com/en-ie/102390" target="_blank" rel="noreferrer">iPhone and iPad instructions<ExternalLinkIcon className="size-4" /></WorkbenchLinkButton>
      <WorkbenchLinkButton href="https://support.apple.com/en-ie/guide/keychain-access/kyca11871/mac" target="_blank" rel="noreferrer">Mac instructions<ExternalLinkIcon className="size-4" /></WorkbenchLinkButton>
      <WorkbenchLinkButton href="https://support.google.com/pixelphone/answer/2844832?hl=en" target="_blank" rel="noreferrer">Android instructions<ExternalLinkIcon className="size-4" /></WorkbenchLinkButton>
    </Disclosure>
  </>;
}
