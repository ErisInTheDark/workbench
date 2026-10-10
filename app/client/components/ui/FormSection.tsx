/*
 * Exports:
 * - default FormSection: titled section shared by settings pages and full-page forms.
 */
"use client";

import type { ReactNode } from "react";

export default function FormSection ({ id, title, description, children }: {
  id?: string;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return <section id={id} className="scroll-mt-24 space-y-1">
    <h2 className="m-0 pb-1 pt-6 text-base font-semibold text-text">{title}</h2>
    {description ? <p className="m-0 mb-2 text-[0.8rem] leading-5 text-fg/muted">{description}</p> : null}
    {children}
  </section>;
}
