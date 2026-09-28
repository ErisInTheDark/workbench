/* Exports: default ThreadUserImage resolves stored transcript assets for thumbnail and lightbox display. */
"use client";

import { getWorkbenchTranscriptAssetUrl, useWorkbenchDaemonAssetOrigin } from "../WorkbenchWorkspaceContext";
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
  const resolvedSrc = getWorkbenchTranscriptAssetUrl(src, useWorkbenchDaemonAssetOrigin());
  if (!resolvedSrc) return <span className={className}>Image unavailable.</span>;
  return (
    <ThreadLightboxImage
      alt={alt}
      buttonClassName={className}
      imageClassName="h-auto max-h-[16rem] w-auto max-w-full object-contain"
      src={resolvedSrc}
    />
  );
}
