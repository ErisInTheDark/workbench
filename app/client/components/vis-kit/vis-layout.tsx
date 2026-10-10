/*
 * Exports:
 * - Section: titled block with an optional description.
 * - Compare: side-by-side columns that stack on narrow frames.
 * - Stat: one labelled headline value with an optional hint.
 * - Callout: Markdown in the thread's coloured notice style.
 * - Table: plain header-and-rows table in the flush style.
 * - Swatch: one colour chip with its label.
 */
import type { ReactNode } from "react";
import MarkdownRender from "../ui/MarkdownRender";

export function Section({ children, description, title }: { children: ReactNode; description?: ReactNode; title: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 p-4">
      <header>
        <h2 className="text-lg font-semibold text-text">{title}</h2>
        {description ? <p className="mt-0.5 text-sm text-fg/muted">{description}</p> : null}
      </header>
      {children}
    </section>
  );
}

export function Compare({ children, columns = 2 }: { children: ReactNode; columns?: 2 | 3 | 4 }) {
  const grid = columns === 4 ? "sm:grid-cols-2 lg:grid-cols-4" : columns === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2";
  return <div className={`grid gap-3 ${grid}`}>{children}</div>;
}

export function Stat({ hint, label, value }: { hint?: ReactNode; label: ReactNode; value: ReactNode }) {
  return (
    <div className="flex flex-col">
      <span className="text-sm text-fg/muted">{label}</span>
      <span className="text-2xl font-semibold leading-tight text-text">{value}</span>
      {hint ? <span className="text-xs text-fg/muted">{hint}</span> : null}
    </div>
  );
}

export function Callout({ children, title, tone = "blue" }: {
  /** Markdown. */
  children: string;
  title?: string;
  tone?: "blue" | "green" | "purple" | "yellow" | "red";
}) {
  const heading = title ? ` title="${title.replaceAll("\"", "&quot;")}"` : "";
  return <MarkdownRender markdown={`<notice${heading} color="${tone}">\n\n${children}\n\n</notice>`} />;
}

export function Table({ columns, rows }: { columns: readonly ReactNode[]; rows: readonly (readonly ReactNode[])[] }) {
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr>{columns.map((column, index) => <th className="px-2 py-1.5 text-left font-medium text-fg/muted" key={index}>{column}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr className="border-t border-fg/8" key={rowIndex}>
            {row.map((cell, cellIndex) => <td className="px-2 py-1.5 text-text" key={cellIndex}>{cell}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Swatch({ color, label }: { color: string; label?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-text">
      <span aria-hidden="true" className="size-5 rounded-md border border-fg/10" style={{ background: color }} />
      {label ?? color}
    </span>
  );
}
