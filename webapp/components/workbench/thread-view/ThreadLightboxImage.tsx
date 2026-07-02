/*
 * Exports:
 * - default ThreadLightboxImage: render a thumbnail button and document-level image lightbox. Keywords: thread, image, lightbox, portal.
 * - Local helpers: class joining and Escape-key lightbox close handling. Keywords: image preview, modal, document body.
 */
"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

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
  const lightboxPortalHost = typeof document === "undefined" ? null : document.body;

  useEffect(() => {
    if (!isLightboxOpen) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsLightboxOpen(false);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isLightboxOpen]);

  const lightbox = isLightboxOpen ? (
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
  ) : null;

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

      {lightbox && lightboxPortalHost ? createPortal(lightbox, lightboxPortalHost) : lightbox}
    </>
  );
}
