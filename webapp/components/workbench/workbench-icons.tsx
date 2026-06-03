/*
 * Exports:
 * - CodexIcon/CopilotIcon/HarnessIcon: render harness-specific icons for thread and rate-limit UI. Keywords: workbench, icon, harness, codex, copilot.
 * - SaveIcon: render the save control icon with its disabled slash overlay. Keywords: workbench, icon, save.
 * - BinIcon: render the discard-draft bin icon. Keywords: workbench, icon, reset.
 * - ZoomOutIcon: render the decrease text size icon. Keywords: workbench, icon, zoom.
 * - ZoomInIcon: render the increase text size icon. Keywords: workbench, icon, zoom.
 * - BackArrowIcon: render the mobile back-navigation icon. Keywords: workbench, icon, navigation.
 * - GearIcon: render the settings navigation icon. Keywords: workbench, icon, settings.
 * - ReloadIcon: render the local runtime reload icon. Keywords: workbench, icon, reload.
 * - WrapTextIcon: render the thread codeblock line-wrap toggle icon. Keywords: workbench, icon, thread, code, wrap.
 */
import type { WorkbenchHarness } from "../../lib/types";

export function CodexIcon ({ className = "size-4" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="currentColor"
      fillRule="evenodd"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path clipRule="evenodd" d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z" />
    </svg>
  );
}

export function CopilotIcon ({ className = "size-4" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="currentColor"
      fillRule="evenodd"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M19.245 5.364c1.322 1.36 1.877 3.216 2.11 5.817.622 0 1.2.135 1.592.654l.73.964c.21.278.323.61.323.955v2.62c0 .339-.173.669-.453.868C20.239 19.602 16.157 21.5 12 21.5c-4.6 0-9.205-2.583-11.547-4.258-.28-.2-.452-.53-.453-.868v-2.62c0-.345.113-.679.321-.956l.73-.963c.392-.517.974-.654 1.593-.654l.029-.297c.25-2.446.81-4.213 2.082-5.52 2.461-2.54 5.71-2.851 7.146-2.864h.198c1.436.013 4.685.323 7.146 2.864zm-7.244 4.328c-.284 0-.613.016-.962.05-.123.447-.305.85-.57 1.108-1.05 1.023-2.316 1.18-2.994 1.18-.638 0-1.306-.13-1.851-.464-.516.165-1.012.403-1.044.996a65.882 65.882 0 00-.063 2.884l-.002.48c-.002.563-.005 1.126-.013 1.69.002.326.204.63.51.765 2.482 1.102 4.83 1.657 6.99 1.657 2.156 0 4.504-.555 6.985-1.657a.854.854 0 00.51-.766c.03-1.682.006-3.372-.076-5.053-.031-.596-.528-.83-1.046-.996-.546.333-1.212.464-1.85.464-.677 0-1.942-.157-2.993-1.18-.266-.258-.447-.661-.57-1.108-.32-.032-.64-.049-.96-.05zm-2.525 4.013c.539 0 .976.426.976.95v1.753c0 .525-.437.95-.976.95a.964.964 0 01-.976-.95v-1.752c0-.525.437-.951.976-.951zm5 0c.539 0 .976.426.976.95v1.753c0 .525-.437.95-.976.95a.964.964 0 01-.976-.95v-1.752c0-.525.437-.951.976-.951zM7.635 5.087c-1.05.102-1.935.438-2.385.906-.975 1.037-.765 3.668-.21 4.224.405.394 1.17.657 1.995.657h.09c.649-.013 1.785-.176 2.73-1.11.435-.41.705-1.433.675-2.47-.03-.834-.27-1.52-.63-1.813-.39-.336-1.275-.482-2.265-.394zm6.465.394c-.36.292-.6.98-.63 1.813-.03 1.037.24 2.06.675 2.47.968.957 2.136 1.104 2.776 1.11h.044c.825 0 1.59-.263 1.995-.657.555-.556.765-3.187-.21-4.224-.45-.468-1.335-.804-2.385-.906-.99-.088-1.875.058-2.265.394zM12 7.615c-.24 0-.525.015-.84.044.03.16.045.336.06.526l-.001.159a2.94 2.94 0 01-.014.25c.225-.022.425-.027.612-.028h.366c.187 0 .387.006.612.028-.015-.146-.015-.277-.015-.409.015-.19.03-.365.06-.526a9.29 9.29 0 00-.84-.044z" />
    </svg>
  );
}

export function HarnessIcon ({ className = "size-4", harness }: { className?: string; harness: WorkbenchHarness }) {
  return harness === "copilot"
    ? <CopilotIcon className={className} />
    : <CodexIcon className={className} />;
}

export function SaveIcon () {
  return (
    <span className="relative block size-5">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" className="save-icon-main size-5">
        <path d="M15.5 17.5H4.5a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1H14l2.5 2.5V16.5a1 1 0 0 1-1 1z" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M7.5 2.5v5h5v-5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M5.5 12h9v5.5h-9z" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {/* the slash only shows when saving is not currently possible */}
      <svg
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        aria-hidden="true"
        className="save-icon-slash pointer-events-none absolute inset-0 size-5 opacity-0 transition-opacity"
      >
        <path d="M3.5 16.5L16.5 3.5" strokeLinecap="round" />
      </svg>
    </span>
  );
}

export function BinIcon () {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" className="size-5">
      <path d="M3.5 6.5H16.5" strokeLinecap="round" />
      <path d="M8.5 3.5H11.5C11.78 3.5 12 3.72 12 4V6.5H8V4C8 3.72 8.22 3.5 8.5 3.5Z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5.5 6.5L6.5 16C6.56 16.56 7.04 17 7.6 17H12.4C12.96 17 13.44 16.56 13.5 16L14.5 6.5H5.5Z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.5 9V14M11.5 9V14" strokeLinecap="round" />
    </svg>
  );
}

export function ZoomOutIcon () {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" className="size-5">
      <circle cx="8.75" cy="8.75" r="5.25" />
      <path d="M5.75 8.75H11.75" strokeLinecap="round" />
      <path d="M14 14L17.5 17.5" strokeLinecap="round" />
    </svg>
  );
}

export function ZoomInIcon () {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" className="size-5">
      <circle cx="8.75" cy="8.75" r="5.25" />
      <path d="M8.75 5.75V11.75M5.75 8.75H11.75" strokeLinecap="round" />
      <path d="M14 14L17.5 17.5" strokeLinecap="round" />
    </svg>
  );
}

export function BackArrowIcon () {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" className="size-5">
      <path d="M12.75 4.75L7.25 10L12.75 15.25" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7.75 10H16.25" strokeLinecap="round" />
    </svg>
  );
}

export function GearIcon () {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" className="size-5">
      <path d="M8.45 2.75H11.55L12.12 5.05C12.5 5.2 12.86 5.4 13.18 5.66L15.38 4.98L16.92 7.64L15.28 9.28C15.34 9.74 15.34 10.26 15.28 10.72L16.92 12.36L15.38 15.02L13.18 14.34C12.86 14.6 12.5 14.8 12.12 14.95L11.55 17.25H8.45L7.88 14.95C7.5 14.8 7.14 14.6 6.82 14.34L4.62 15.02L3.08 12.36L4.72 10.72C4.66 10.26 4.66 9.74 4.72 9.28L3.08 7.64L4.62 4.98L6.82 5.66C7.14 5.4 7.5 5.2 7.88 5.05L8.45 2.75Z" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="10" cy="10" r="2.45" />
    </svg>
  );
}

export function ReloadIcon () {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" className="size-5">
      <path d="M16.25 9.25A6.25 6.25 0 0 0 5.3 5.12L3.75 6.75" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.75 3.75V6.75H6.75" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.75 10.75A6.25 6.25 0 0 0 14.7 14.88L16.25 13.25" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16.25 16.25V13.25H13.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function WrapTextIcon ({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.65" aria-hidden="true" className={className}>
      <path d="M3.5 5.5H16.5" strokeLinecap="round" />
      <path d="M3.5 9.5H13.25C15.05 9.5 16.5 10.82 16.5 12.45C16.5 14.08 15.05 15.4 13.25 15.4H10.25" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.1 13.35L10.05 15.4L12.1 17.45" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.5 13.5H7.5" strokeLinecap="round" />
    </svg>
  );
}
