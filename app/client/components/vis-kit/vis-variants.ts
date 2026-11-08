/*
 * Exports:
 * - VisVariantContext: the design a vis mockup picked for each exploration id, carried to real components; empty in the app.
 * - useVisVariant: a real component's picked design for an exploration id, or its default outside a mockup. Prune an
 *   exploration's losing designs and this call once the user picks.
 */
"use client";

import { createContext, useContext } from "react";

export const VisVariantContext = createContext<Readonly<Record<string, string>>>({});

export function useVisVariant<Variant extends string>(id: string, variants: readonly [Variant, ...Variant[]]): Variant {
  const picked = useContext(VisVariantContext)[id];
  return variants.find(variant => variant === picked) ?? variants[0];
}
