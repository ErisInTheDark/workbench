# ADR-0001: Inline Run DOM Invariant

## Context

The rich markdown editor canonicalizes rendered and edited inline content before saving. Save-guard checks compare that canonical editor structure against markdown rendered back into DOM.

## Decision

Inline run DOM invariant: after editor structural sync, each inline run segment is homogeneous by its full formatting mark set, and whitespace between adjacent formatted segments remains unformatted text. Markdown save-guard round trips must compare against this canonicalized editor structure, not raw renderer HTML.

## Consequences

Inline canonicalization must split boundary whitespace out of formatted runs and avoid merging shorter-format runs into wrappers that contain deeper formatting. Save-guard round trips must use the same structural sync path as normal rich editor rendering.
