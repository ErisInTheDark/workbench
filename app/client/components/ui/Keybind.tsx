/*
 * Exports:
 * - isApplePlatform: whether shortcuts use Cmd and Option rather than Ctrl and Alt.
 * - default Keybind: one key chord as a row of key caps, for tooltips and menus.
 */
"use client";

export function isApplePlatform() {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/u.test(navigator.platform || navigator.userAgent);
}

export default function Keybind({ keys }: { keys: readonly string[] }) {
  return (
    <kbd className="inline-flex items-center gap-0.5 font-sans" aria-label={keys.join("+")}>
      {keys.map((key) => (
        <span
          key={key}
          aria-hidden="true"
          className="
            inline-flex h-[1.35rem] min-w-[1.35rem] items-center justify-center rounded-[0.4rem] px-1
            bg-fg/8 text-[0.72rem] font-medium leading-none text-fg/70
          "
        >
          {key}
        </span>
      ))}
    </kbd>
  );
}
