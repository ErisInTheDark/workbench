/*
 * Exports:
 * - SaveIcon: render the save control icon with its disabled slash overlay. Keywords: workbench, icon, save.
 * - BinIcon: render the discard-draft bin icon. Keywords: workbench, icon, reset.
 * - ZoomOutIcon: render the decrease text size icon. Keywords: workbench, icon, zoom.
 * - ZoomInIcon: render the increase text size icon. Keywords: workbench, icon, zoom.
 * - BackArrowIcon: render the mobile back-navigation icon. Keywords: workbench, icon, navigation.
 */
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
