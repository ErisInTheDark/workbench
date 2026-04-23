"use client";

import { useState } from "react";

function joinClasses(...values: Array<string | undefined>) {
  return values.filter(Boolean).join(" ");
}

export default function ThreadLightboxImage({
  alt,
  buttonClassName,
  imageClassName,
  src,
}: {
  alt: string;
  buttonClassName?: string;
  imageClassName?: string;
  src: string;
}) {
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className={joinClasses(
          "block overflow-hidden rounded-[1rem] bg-[color-mix(in_srgb,var(--text)_4%,transparent)] text-left transition hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft",
          buttonClassName,
        )}
        onClick={() => {
          setIsLightboxOpen(true);
        }}
      >
        <img
          src={src}
          alt={alt}
          className={joinClasses(
            "block max-w-full",
            imageClassName,
          )}
        />
      </button>

      {isLightboxOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[color-mix(in_srgb,var(--bg)_74%,transparent)] p-6 backdrop-blur-sm"
          onClick={() => {
            setIsLightboxOpen(false);
          }}
        >
          <img
            src={src}
            alt={alt}
            className="block h-auto w-auto max-h-[calc(100vh-3rem)] max-w-[calc(100vw-3rem)] rounded-[1rem] shadow-float"
          />
        </div>
      ) : null}
    </>
  );
}
