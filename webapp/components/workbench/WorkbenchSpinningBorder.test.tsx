/*
 * Exports:
 * - No production exports; Node tests protect shared motion-path ownership and PrimaryButton integration. Keywords: workbench, pending, border, motion path.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import PrimaryButton from "./PrimaryButton";
import WorkbenchSpinningBorder from "./WorkbenchSpinningBorder";

test("spinning borders render two opposed motion-path elements", () => {
  const html = renderToStaticMarkup(createElement(WorkbenchSpinningBorder, {
    radius: "50cqb",
  }));

  assert.match(html, /data-workbench-spinning-border="true"/u);
  assert.equal(html.match(/data-workbench-spinning-border-trail="true"/gu)?.length, 2);
  assert.match(html, /workbench-spinning-border-trail-first/u);
  assert.match(html, /workbench-spinning-border-trail-second/u);
  assert.match(html, /--workbench-spinning-border-radius:50cqb/u);
});

test("PrimaryButton uses the shared border for pending pills", () => {
  const html = renderToStaticMarkup(createElement(PrimaryButton, {
    children: "Committing...",
    disabled: true,
    pendingHalo: true,
  }));

  assert.match(html, />Committing\.\.\.</u);
  assert.match(html, /data-workbench-spinning-border="true"/u);
  assert.match(html, /inset-\[3px\]/u);
  assert.match(html, /disabled:\[color:color-mix\(in_srgb,var\(--text\)_32%,transparent\)\]/u);
  assert.doesNotMatch(html, /disabled:\[color:color-mix\(in_srgb,var\(--text\)_10%,transparent\)\]/u);
});

test("PrimaryButton exposes opt-in danger hold confirmation without changing its normal state", () => {
  const html = renderToStaticMarkup(createElement(PrimaryButton, {
    children: "Hold to restore & unclaim",
    holdToConfirmMs: 2000,
    tone: "danger",
  }));

  assert.match(html, /data-hold-to-confirm-ms="2000"/u);
  assert.match(html, /data-tone="danger"/u);
  assert.match(html, /enabled:hover:\[--primary-button-bg:color-mix\(in_srgb,var\(--danger\)_48%,var\(--shell-fade-bg\)_52%\)\]/u);
  assert.match(html, /enabled:focus-visible:\[color:var\(--text\)\]/u);
  assert.match(html, /data-\[confirming=true\]:\[--primary-button-bg:color-mix\(in_srgb,var\(--danger\)_72%,var\(--shell-fade-bg\)_28%\)\]/u);
  assert.match(html, /data-primary-button-confirmation-rail="true"/u);
  assert.match(html, /data-primary-button-confirmation-progress="true"/u);
  assert.match(html, /absolute inset-x-0 bottom-0 h-1\.5/u);
  assert.match(html, /bg-\[color:var\(--text\)\]/u);
  assert.match(html, /transform:scaleX\(0\);transition-duration:0ms/u);
  assert.doesNotMatch(html, /data-confirming="true"/u);
});

test("PrimaryButton keeps ordinary disabled actions visually quieter", () => {
  const html = renderToStaticMarkup(createElement(PrimaryButton, {
    children: "Unavailable",
    disabled: true,
  }));

  assert.match(html, /disabled:\[color:color-mix\(in_srgb,var\(--text\)_10%,transparent\)\]/u);
  assert.doesNotMatch(html, /disabled:\[color:color-mix\(in_srgb,var\(--text\)_32%,transparent\)\]|data-workbench-spinning-border="true"/u);
});
