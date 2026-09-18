/* Exports: default ThreadUserImage resolves stored transcript assets for thumbnail and lightbox display. */
"use client";

import { useSyncExternalStore } from "react";
import { getWorkbenchTranscriptAssetUrl, workbenchDaemonConnection } from "workbench-shared/workbench/workbench-connection";
import ThreadLightboxImage from "./ThreadLightboxImage";

export default function ThreadUserImage({
  alt,
  className,
  src,
}: {
  alt: string;
  className?: string;
  src: string;
}) {
  useSyncExternalStore(workbenchDaemonConnection.subscribe, workbenchDaemonConnection.getSnapshot, workbenchDaemonConnection.getSnapshot);
  const resolvedSrc = getWorkbenchTranscriptAssetUrl(src);
  if (!resolvedSrc) return <span className={className}>Image unavailable while the daemon is disconnected.</span>;
  return (
    <ThreadLightboxImage
      alt={alt}
      buttonClassName={className}
      imageClassName="h-auto max-h-[16rem] w-auto max-w-full object-contain"
      src={resolvedSrc}
    />
  );
}
