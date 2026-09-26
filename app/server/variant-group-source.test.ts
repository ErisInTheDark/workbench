/*
 * No production exports. Tests protect grouped Tailwind classes across source literals.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { expandVariantGroupsInSource } from "./variant-group-source.ts";

test("expands grouped variants in static and conditional class strings", () => {
  const source = [
    'const staticClasses = "hover:(bg-accent-soft text-accent)";',
    'const nestedClasses = "md:(px-2 hover:(bg-[color-mix(in_srgb,var(--text)_7%,transparent)] text-text))";',
    'const conditionalClasses = `base ${selected ? "focus-visible:(outline-none ring-2)" : ""}`;',
    'const splitTemplate = `hover:(bg-accent-soft text-accent) ${selected ? "ring-2" : ""} focus:(outline-none ring-2)`;',
    'const button = <button className="focus:(outline-none ring-2)" />;',
  ].join("\n");

  const { code } = expandVariantGroupsInSource(source, "Button.tsx");

  assert.match(code, /hover:bg-accent-soft hover:text-accent/u);
  assert.match(code, /md:px-2 md:hover:bg-\[color-mix\(in_srgb,var\(--text\)_7%,transparent\)\] md:hover:text-text/u);
  assert.match(code, /selected \? "focus-visible:outline-none focus-visible:ring-2" : ""/u);
  assert.match(code, /`hover:bg-accent-soft hover:text-accent \$\{selected \? "ring-2" : ""\} focus:outline-none focus:ring-2`/u);
  assert.match(code, /<button className="focus:outline-none focus:ring-2" \/>/u);
  assert.doesNotMatch(code, /hover:\(|md:\(|focus-visible:\(|focus:\(/u);
});

test("leaves ordinary source and template interpolation boundaries alone", () => {
  const source = 'const classes = `base ${selected ? "text-accent" : "text-text"}`;';
  assert.equal(expandVariantGroupsInSource(source, "Button.tsx").code, source);
});

test("turns whitespace inside bracket classes into one class without joining neighbours", () => {
  const source = [
    "const classes = `px-2 [transition:",
    "  opacity .3s,",
    "  transform .5s",
    "] hover:([mask-type: alpha] text-white) ${active ? 'ring-2' : ''}`;",
  ].join("\n");

  const { code } = expandVariantGroupsInSource(source, "Button.tsx");

  assert.match(code, /px-2 \[transition:opacity_\.3s,_transform_\.5s\] hover:\[mask-type:alpha\] hover:text-white \$\{active/u);
  assert.match(code, /active \? 'ring-2' : ''/u);
});

test("rejects an incomplete group instead of building an unstyled class", () => {
  assert.throws(() => expandVariantGroupsInSource('const classes = "hover:(bg-accent";', "Button.tsx"));
});
