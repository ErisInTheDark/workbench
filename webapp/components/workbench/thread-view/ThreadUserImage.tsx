"use client";

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
  return (
    <ThreadLightboxImage
      alt={alt}
      buttonClassName={className}
      imageClassName="h-auto max-h-[16rem] w-auto max-w-full object-contain"
      src={src}
    />
  );
}
