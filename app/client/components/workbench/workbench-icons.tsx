/*
 * Exports:
 * - IconProps: shared icon size and SVG attributes.
 * - ZapIcon: fast mode outlined lightning glyph.
 * - StarIcon/StarOffIcon: emphasise and de-emphasise model choices.
 * - BotIcon: composer profile glyph.
 * - CodexIcon/CopilotIcon/OpenCodeIcon/HarnessIcon: harness identity glyphs.
 * - BookIcon/BookBookmarkIcon/BookSearchIcon and dashed variants: Thread Recall activity and empty-result glyphs.
 * - SaveIcon: save glyph with disabled slash.
 * - DraftThreadIcon/ComposerDraftIcon/NeedsAttentionThreadIcon/CompletedThreadIcon/ProposedCommitThreadIcon/WorkingThreadIcon/StoppedThreadIcon: lifecycle and draft glyphs.
 * - DiscardDraftIcon/SettleThreadIcon/RestoreThreadIcon/UnsnoozeThreadIcon/SnoozedThreadIcon: sidebar action glyphs.
 * - BinIcon: discard glyph.
 * - ZoomInIcon: text-size control.
 * - BackArrowIcon: mobile back navigation.
 * - SidebarCollapseIcon/SidebarExpandIcon: sidebar visibility controls.
 * - PanelMinimizeIcon/PanelExpandIcon/PanelCloseIcon: mosaic panel controls.
 * - HomeIcon/StatsIcon/GearIcon: main navigation glyphs.
 * - ProjectIcon: project section glyph.
 * - BrowserSessionIcon: browser session glyph.
 * - ReloadIcon: runtime reload glyph.
 * - StopIcon/PlayIcon/ClockIcon/WarningIcon/CircleAlertIcon: execution status and alert glyphs.
 * - PinIcon/FolderClosedIcon/FolderOpenIcon/FolderInputIcon/LockIcon/UnlockIcon: folder and ownership glyphs.
 * - FlagIcon: goal glyph.
 * - OpenThreadIcon/ArchiveIcon: thread navigation and archive glyphs.
 * - WrapTextIcon/PreviewIcon: code display controls.
 * - CopyIcon/MoreVerticalIcon/CheckIcon: copy, overflow and confirmation glyphs.
 * - AsteriskIcon/PlusIcon: amend and fresh-commit choices.
 * - SparkleIcon: creation glyph.
 * - FileAddIcon/FileDeleteIcon/FileMoveIcon: file-change glyphs.
 * - FileUpdateIcon: file-change alias.
 * - SquareArrowRightEnterIcon/SquareEqualIcon/SquareArrowRightExitIcon: token input, cache and output glyphs.
 * - SendHorizontalIcon: outlined send glyph.
 * - SquareIcon: outlined square.
 * - PanelLeftCloseIcon/PanelLeftOpenIcon: panel visibility glyphs.
 * - SquareMinusIcon/SquarePlusIcon/XIcon: geometric panel-action glyphs.
 * - SettingsIcon/ChartNoAxesCombinedIcon: settings and chart glyphs.
 * - EyeIcon/EyeOffIcon/SearchIcon: visibility and search glyphs.
 * - FilePlusIcon/ExternalLinkIcon: file creation and external navigation glyphs.
 * - ArrowRightIcon/ArrowUpIcon/ChevronDownIcon/ChevronUpIcon: directional glyphs.
 * - FolderGit2Icon/AppWindowIcon/RefreshCwIcon: project, browser and refresh glyphs.
 * - MessageCircleDashedIcon/MessageCircleQuestionMarkIcon/MessageCircleCheckIcon/MessageCircleGitCommitIcon/MessageCircleMoreIcon/MessageCircleXIcon: message glyphs.
 * - SquarePenIcon/CheckCheckIcon/AlarmClockIcon/ZzzIcon: editing and status glyphs.
 * - Trash2Icon/TriangleAlertIcon: miscellaneous base glyphs.
 * - CompactIcon/QuestionnaireListIcon/EllipsisIcon/FeatherIcon: thread action glyphs.
 * - FoldWorkedRunIcon/UnfoldWorkedRunIcon/ReapplyTitleIcon/TitleCommandIcon: thread workflow glyphs.
 * - GitArcIcon and Git arc action/claim-state glyphs: Git arc status and action glyphs.
 */
import type { ComponentPropsWithoutRef } from "react";
import type { WorkbenchHarness } from "workbench-shared/types";
import type { GitArcCommandAction } from "../../workbench/thread/command-matchers/git-checkpoints";

type IconSize = 12 | 14 | 16 | 18 | 20 | 22 | 32;

export type IconProps = Omit<ComponentPropsWithoutRef<"svg">, "height" | "strokeWidth" | "width"> & {
  size?: IconSize;
};

function OutlinedIcon({ size = 16, ...props }: IconProps) {
  return <svg {...props} aria-hidden="true" fill="none" height={size} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={32 / size} viewBox="0 0 24 24" width={size} xmlns="http://www.w3.org/2000/svg" />;
}

function BrandIcon({ size = 16, ...props }: IconProps) {
  return <svg {...props} aria-hidden="true" height={size} width={size} xmlns="http://www.w3.org/2000/svg" />;
}

type DashedBookDetail = "bookmark" | "search" | null;

function DashedBookIcon({ detail, ...props }: IconProps & { detail: DashedBookDetail }) {
  return (
    <OutlinedIcon {...props}>
      <path d="M12 17h1.5" />
      <path d="M12 22h1.5" />
      <path d="M12 2h1.5" />
      <path d="M17.5 22H19a1 1 0 0 0 1-1" />
      <path d="M17.5 2H19a1 1 0 0 1 1 1v1.5" />
      <path d="M20 14v3h-2.5" />
      <path d="M20 8.5V10" />
      <path d="M4 10V8.5" />
      <path d="M4 19.5V14" />
      <path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H8" />
      <path d="M8 22H6.5a1 1 0 0 1 0-5H8" />
      {detail === "bookmark" ? <path d="M10 2v7.751a.25.25 0 0 0 .407.195l2.28-1.834a.5.5 0 0 1 .627 0l2.28 1.834A.25.25 0 0 0 16 9.751V2" /> : null}
      {detail === "search" ? <><path d="m21 22-1.879-1.878" /><circle cx="17" cy="18" r="3" /></> : null}
    </OutlinedIcon>
  );
}

export function BookIcon(props: IconProps) {
  return <OutlinedIcon {...props}><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20" /></OutlinedIcon>;
}

export function BookBookmarkIcon(props: IconProps) {
  return <OutlinedIcon {...props}><path d="M10 2v7.751a.25.25 0 0 0 .407.195l2.28-1.834a.5.5 0 0 1 .627 0l2.28 1.834A.25.25 0 0 0 16 9.751V2" /><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20" /></OutlinedIcon>;
}

export function BookSearchIcon(props: IconProps) {
  return <OutlinedIcon {...props}><path d="M11 22H5.5a1 1 0 0 1 0-5h4.501" /><path d="m21 22-1.879-1.878" /><path d="M3 19.5v-15A2.5 2.5 0 0 1 5.5 2H18a1 1 0 0 1 1 1v8" /><circle cx="17" cy="18" r="3" /></OutlinedIcon>;
}

export function BookDashedIcon(props: IconProps) {
  return <DashedBookIcon {...props} detail={null} />;
}

export function BookBookmarkDashedIcon(props: IconProps) {
  return <DashedBookIcon {...props} detail="bookmark" />;
}

export function BookSearchDashedIcon(props: IconProps) {
  return <DashedBookIcon {...props} detail="search" />;
}

export function BotIcon(props: IconProps) {
  return <OutlinedIcon {...props}>
    <path d="M12 8V4H8" /><rect width="16" height="12" x="4" y="8" rx="2" /><path d="M2 14h2" /><path d="M20 14h2" /><path d="M15 13v2" /><path d="M9 13v2" />
  </OutlinedIcon>;
}

export function StarIcon(props: IconProps) {
  return <OutlinedIcon {...props}>
    <path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z" />
  </OutlinedIcon>;
}

export function StarOffIcon(props: IconProps) {
  return <OutlinedIcon {...props}>
    <path d="m10.344 4.688 1.181-2.393a.53.53 0 0 1 .95 0l2.31 4.679a2.12 2.12 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.237 3.152" />
    <path d="m17.945 17.945.43 2.505a.53.53 0 0 1-.771.56l-4.618-2.428a2.12 2.12 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.12 2.12 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a8 8 0 0 0 .4-.099" />
    <path d="m2 2 20 20" />
  </OutlinedIcon>;
}

export function ZapIcon(props: IconProps) {
  return <OutlinedIcon {...props}>
    <path d="M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z" />
  </OutlinedIcon>;
}

export function SquareArrowRightEnterIcon(props: IconProps) {
  return (
    <OutlinedIcon {...props}>
      <path d="m10 16 4-4-4-4" /><path d="M3 12h11" /><path d="M3 8V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3" />
    </OutlinedIcon>
  );
}

export function SquareEqualIcon(props: IconProps) {
  return (
    <OutlinedIcon {...props}>
      <rect width="18" height="18" x="3" y="3" rx="2" /><path d="M7 10h10" /><path d="M7 14h10" />
    </OutlinedIcon>
  );
}

export function SquareArrowRightExitIcon(props: IconProps) {
  return (
    <OutlinedIcon {...props}>
      <path d="M10 12h11" /><path d="m17 16 4-4-4-4" /><path d="M21 6.344V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-1.344" />
    </OutlinedIcon>
  );
}

export function CodexIcon(props: IconProps) {
  return (
    <BrandIcon
      {...props}
      fill="none"
      viewBox="180.5 180.5 354.67 354.67"
    >
      <path d="M508.749 317.399C516.777 287.314 508.991 253.884 485.389 230.282C461.788 206.681 428.36 198.895 398.273 206.923C376.231 184.928 343.39 174.956 311.148 183.596C278.906 192.234 255.45 217.292 247.36 247.361C217.291 255.451 192.233 278.91 183.595 311.149C174.957 343.391 184.927 376.232 206.924 398.274C198.896 428.359 206.683 461.789 230.284 485.391C253.885 508.992 287.313 516.779 317.401 508.75C339.442 530.745 372.286 540.717 404.525 532.079C436.767 523.441 460.223 498.384 468.313 468.315C498.383 460.224 523.44 436.766 532.078 404.526C540.716 372.285 530.747 339.443 508.749 317.402V317.399ZM470.899 244.776C486.892 260.77 493.488 282.601 490.687 303.412L415.577 260.046C412.411 258.218 408.509 258.218 405.345 260.046L317.401 310.82V277.526C317.401 275.191 318.652 273.005 320.676 271.837L387.644 233.174C414.178 218.353 448.346 222.223 470.901 244.776H470.899ZM357.837 311.144L398.275 334.491V381.185L357.837 404.532L317.398 381.185V334.491L357.837 311.144ZM264.776 269.693C265.207 239.305 285.644 211.649 316.453 203.393C338.3 197.54 360.505 202.744 377.127 215.573L302.014 258.937C298.848 260.764 296.898 264.144 296.898 267.798V369.346L268.065 352.699C266.043 351.531 264.776 349.353 264.776 347.017V269.691V269.693ZM203.391 316.454C209.244 294.608 224.854 277.978 244.276 269.999V356.73C244.276 360.384 246.226 363.763 249.392 365.591L337.337 416.365L308.503 433.013C306.481 434.181 303.961 434.188 301.939 433.02L234.971 394.357C208.868 378.789 195.138 347.261 203.391 316.454ZM244.775 470.9C228.781 454.906 222.186 433.075 224.986 412.264L300.096 455.63C303.263 457.457 307.164 457.457 310.328 455.63L398.273 404.856V438.149C398.273 440.485 397.022 442.671 394.997 443.839L328.029 482.502C301.495 497.322 267.327 493.452 244.772 470.9H244.775ZM450.897 445.982C450.466 476.371 430.029 504.027 399.22 512.283C377.373 518.136 355.168 512.932 338.547 500.102L413.659 456.738C416.826 454.911 418.775 451.532 418.775 447.877V346.329L447.609 362.977C449.631 364.145 450.897 366.323 450.897 368.659V445.985V445.982ZM512.282 399.221C506.429 421.068 490.819 437.697 471.397 445.676V358.946C471.397 355.292 469.448 351.912 466.281 350.085L378.336 299.311L407.17 282.663C409.192 281.495 411.712 281.487 413.734 282.655L480.702 321.318C506.805 336.887 520.536 368.415 512.282 399.221Z" fill="currentColor" />
    </BrandIcon>
  );
}

export function CopilotIcon(props: IconProps) {
  return (
    <BrandIcon
      {...props}
      fill="currentColor"
      fillRule="evenodd"
      viewBox="0 0 24 24"
    >
      <path d="M19.245 5.364c1.322 1.36 1.877 3.216 2.11 5.817.622 0 1.2.135 1.592.654l.73.964c.21.278.323.61.323.955v2.62c0 .339-.173.669-.453.868C20.239 19.602 16.157 21.5 12 21.5c-4.6 0-9.205-2.583-11.547-4.258-.28-.2-.452-.53-.453-.868v-2.62c0-.345.113-.679.321-.956l.73-.963c.392-.517.974-.654 1.593-.654l.029-.297c.25-2.446.81-4.213 2.082-5.52 2.461-2.54 5.71-2.851 7.146-2.864h.198c1.436.013 4.685.323 7.146 2.864zm-7.244 4.328c-.284 0-.613.016-.962.05-.123.447-.305.85-.57 1.108-1.05 1.023-2.316 1.18-2.994 1.18-.638 0-1.306-.13-1.851-.464-.516.165-1.012.403-1.044.996a65.882 65.882 0 00-.063 2.884l-.002.48c-.002.563-.005 1.126-.013 1.69.002.326.204.63.51.765 2.482 1.102 4.83 1.657 6.99 1.657 2.156 0 4.504-.555 6.985-1.657a.854.854 0 00.51-.766c.03-1.682.006-3.372-.076-5.053-.031-.596-.528-.83-1.046-.996-.546.333-1.212.464-1.85.464-.677 0-1.942-.157-2.993-1.18-.266-.258-.447-.661-.57-1.108-.32-.032-.64-.049-.96-.05zm-2.525 4.013c.539 0 .976.426.976.95v1.753c0 .525-.437.95-.976.95a.964.964 0 01-.976-.95v-1.752c0-.525.437-.951.976-.951zm5 0c.539 0 .976.426.976.95v1.753c0 .525-.437.95-.976.95a.964.964 0 01-.976-.95v-1.752c0-.525.437-.951.976-.951zM7.635 5.087c-1.05.102-1.935.438-2.385.906-.975 1.037-.765 3.668-.21 4.224.405.394 1.17.657 1.995.657h.09c.649-.013 1.785-.176 2.73-1.11.435-.41.705-1.433.675-2.47-.03-.834-.27-1.52-.63-1.813-.39-.336-1.275-.482-2.265-.394zm6.465.394c-.36.292-.6.98-.63 1.813-.03 1.037.24 2.06.675 2.47.968.957 2.136 1.104 2.776 1.11h.044c.825 0 1.59-.263 1.995-.657.555-.556.765-3.187-.21-4.224-.45-.468-1.335-.804-2.385-.906-.99-.088-1.875.058-2.265.394zM12 7.615c-.24 0-.525.015-.84.044.03.16.045.336.06.526l-.001.159a2.94 2.94 0 01-.014.25c.225-.022.425-.027.612-.028h.366c.187 0 .387.006.612.028-.015-.146-.015-.277-.015-.409.015-.19.03-.365.06-.526a9.29 9.29 0 00-.84-.044z" />
    </BrandIcon>
  );
}

export function OpenCodeIcon(props: IconProps) {
  return (
    <BrandIcon
      {...props}
      fill="currentColor"
      fillRule="evenodd"
      viewBox="0 0 240 300"
    >
      <path d="M240 300H0V0H240V300Z M180 60H60V240H180V60Z" />
      <path d="M180 240H60V120H180V240Z" fillOpacity="0.35" />
    </BrandIcon>
  );
}

export function HarnessIcon({ harness, ...props }: IconProps & { harness: WorkbenchHarness }) {
  if (harness === "copilot") {
    return <CopilotIcon {...props} />;
  }

  if (harness === "opencode") {
    return <OpenCodeIcon {...props} />;
  }

  return harness === "codex" ? <CodexIcon {...props} /> : <BotIcon {...props} />;
}

export function SaveIcon(props: IconProps) {
  return (
    <OutlinedIcon {...props}>
      <g className="save-icon-main">
        <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
        <path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" />
        <path d="M7 3v4a1 1 0 0 0 1 1h7" />
      </g>
      <path className="save-icon-slash opacity-0 transition-opacity" d="M3 21 21 3" />
    </OutlinedIcon>
  );
}

export function Trash2Icon(props: IconProps) {
  return (
    <OutlinedIcon {...props}>
      <path d="M10 11v6" /><path d="M14 11v6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </OutlinedIcon>
  );
}

export function ZoomInIcon(props: IconProps) {
  return (
    <OutlinedIcon {...props}>
      <circle cx="11" cy="11" r="8" /><line x1="21" x2="16.65" y1="21" y2="16.65" /><line x1="11" x2="11" y1="8" y2="14" /><line x1="8" x2="14" y1="11" y2="11" />
    </OutlinedIcon>
  );
}

export function BackArrowIcon(props: IconProps) {
  return <OutlinedIcon {...props}><path d="m15 18-6-6 6-6" /></OutlinedIcon>;
}

export function PanelLeftCloseIcon(props: IconProps) {
  return (
    <OutlinedIcon {...props}>
      <rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18" /><path d="m16 15-3-3 3-3" />
    </OutlinedIcon>
  );
}

export function PanelLeftOpenIcon(props: IconProps) {
  return (
    <OutlinedIcon {...props}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
      <path d="m14 9 3 3-3 3" />
    </OutlinedIcon>
  );
}

export function SquareMinusIcon(props: IconProps) {
  return (
    <OutlinedIcon {...props}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M8 12h8" />
    </OutlinedIcon>
  );
}

export function SquarePlusIcon(props: IconProps) {
  return (
    <OutlinedIcon {...props}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M8 12h8" /><path d="M12 8v8" />
    </OutlinedIcon>
  );
}

export function XIcon(props: IconProps) {
  return (
    <OutlinedIcon {...props}>
      <path d="M18 6 6 18" /><path d="m6 6 12 12" />
    </OutlinedIcon>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <OutlinedIcon {...props}>
      <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" /><circle cx="12" cy="12" r="3" />
    </OutlinedIcon>
  );
}

export function HomeIcon(props: IconProps) {
  return (
    <OutlinedIcon {...props}>
      <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
      <path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </OutlinedIcon>
  );
}

export function FolderGit2Icon(props: IconProps) {
  return (
    <OutlinedIcon {...props}>
      <path d="M18 19a5 5 0 0 1-5-5v8" />
      <path d="M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v5" />
      <circle cx="13" cy="12" r="2" />
      <circle cx="20" cy="19" r="2" />
    </OutlinedIcon>
  );
}

export function AppWindowIcon(props: IconProps) {
  return (
    <OutlinedIcon {...props}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M10 4v4" /><path d="M2 8h20" /><path d="M6 4v4" />
    </OutlinedIcon>
  );
}

export function RefreshCwIcon(props: IconProps) {
  return (
    <OutlinedIcon {...props}>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </OutlinedIcon>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <OutlinedIcon {...props}>
      <path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" />
    </OutlinedIcon>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <OutlinedIcon {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </OutlinedIcon>
  );
}

export function TriangleAlertIcon(props: IconProps) {
  return (
    <OutlinedIcon {...props}>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4" /><path d="M12 17h.01" />
    </OutlinedIcon>
  );
}

export function CircleAlertIcon(props: IconProps) {
  return (
    <OutlinedIcon {...props}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" x2="12" y1="8" y2="12" />
      <line x1="12" x2="12.01" y1="16" y2="16" />
    </OutlinedIcon>
  );
}

export function PinIcon(props: IconProps) {
  return (
    <OutlinedIcon {...props}>
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </OutlinedIcon>
  );
}

export function FolderClosedIcon(props: IconProps) {
  return <OutlinedIcon {...props}><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></OutlinedIcon>;
}

export function FolderOpenIcon(props: IconProps) {
  return <OutlinedIcon {...props}><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" /></OutlinedIcon>;
}

export function FolderInputIcon(props: IconProps) {
  return <OutlinedIcon {...props}><path d="M2 9V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-1" /><path d="M2 13h10" /><path d="m9 16 3-3-3-3" /></OutlinedIcon>;
}

export function LockIcon(props: IconProps) {
  return <OutlinedIcon {...props}><rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></OutlinedIcon>;
}

export function UnlockIcon(props: IconProps) {
  return <OutlinedIcon {...props}><rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 9.9-1" /></OutlinedIcon>;
}

const bubblePath = "M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719";

function MessageCircleIcon({ paths, ...props }: IconProps & { paths: readonly string[] }) {
  return <OutlinedIcon {...props}>{paths.map((path) => <path d={path} key={path} />)}</OutlinedIcon>;
}

export function MessageCircleDashedIcon(props: IconProps) {
  return <MessageCircleIcon {...props} paths={["M10.1 2.182a10 10 0 0 1 3.8 0", "M13.9 21.818a10 10 0 0 1-3.8 0", "M17.609 3.72a10 10 0 0 1 2.69 2.7", "M2.182 13.9a10 10 0 0 1 0-3.8", "M20.28 17.61a10 10 0 0 1-2.7 2.69", "M21.818 10.1a10 10 0 0 1 0 3.8", "M3.721 6.391a10 10 0 0 1 2.7-2.69", "m6.163 21.117-2.906.85a1 1 0 0 1-1.236-1.169l.965-2.98"]} />;
}
export function SquarePenIcon(props: IconProps) {
  return <OutlinedIcon {...props}><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" /></OutlinedIcon>;
}
export function MessageCircleQuestionMarkIcon(props: IconProps) { return <MessageCircleIcon {...props} paths={[bubblePath, "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3", "M12 17h.01"]} />; }
export function MessageCircleCheckIcon(props: IconProps) { return <MessageCircleIcon {...props} paths={[bubblePath, "m9 12 2 2 4-4"]} />; }
export function MessageCircleGitCommitIcon(props: IconProps) { return <MessageCircleIcon {...props} paths={[bubblePath, "M7.5 12h2.9m3.2 0h2.9", "M13.6 12a1.6 1.6 0 1 1-3.2 0 1.6 1.6 0 0 1 3.2 0"]} />; }
export function MessageCircleMoreIcon(props: IconProps) { return <MessageCircleIcon {...props} paths={[bubblePath, "M8 12h.01", "M12 12h.01", "M16 12h.01"]} />; }
export function MessageCircleXIcon(props: IconProps) { return <MessageCircleIcon {...props} paths={[bubblePath, "m15 9-6 6", "m9 9 6 6"]} />; }
export function CheckCheckIcon(props: IconProps) { return <MessageCircleIcon {...props} paths={["M18 6 7 17l-5-5", "m22 10-7.5 7.5L13 16"]} />; }
export function ArrowUpIcon(props: IconProps) { return <OutlinedIcon {...props}><path d="m5 12 7-7 7 7" /><path d="M12 19V5" /></OutlinedIcon>; }
export function AlarmClockIcon(props: IconProps) { return <OutlinedIcon {...props}><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2 2" /><path d="M5 3 2 6" /><path d="m22 6-3-3" /><path d="M6.38 18.7 4 21" /><path d="M17.64 18.67 20 21" /></OutlinedIcon>; }
export function ZzzIcon(props: IconProps) { return <OutlinedIcon {...props}><path d="M4 11h8l-8 10h8" /><path d="M15 4h5l-5 8h5" /></OutlinedIcon>; }

export function FlagIcon(props: IconProps) {
  return (
    <OutlinedIcon {...props}>
      <path d="M6 22V2.8a.8.8 0 0 1 1.17-.71l11.38 5.69a.8.8 0 0 1 0 1.44L6 15.5" />
    </OutlinedIcon>
  );
}

export function ArrowRightIcon(props: IconProps) {
  return (
    <OutlinedIcon {...props}>
      <path d="M5 12h14" /><path d="m12 5 7 7-7 7" />
    </OutlinedIcon>
  );
}

export function ArchiveIcon(props: IconProps) {
  return (
    <OutlinedIcon {...props}>
      <rect width="20" height="5" x="2" y="3" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
    </OutlinedIcon>
  );
}

export function WrapTextIcon(props: IconProps) {
  return (
    <OutlinedIcon {...props}>
      <path d="m16 16-3 3 3 3" />
      <path d="M3 12h14.5a1 1 0 0 1 0 7H13" />
      <path d="M3 19h6" /><path d="M3 5h18" />
    </OutlinedIcon>
  );
}

export function EyeIcon(props: IconProps) {
  return (
    <OutlinedIcon {...props}>
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" /><circle cx="12" cy="12" r="3" />
    </OutlinedIcon>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <OutlinedIcon {...props}>
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </OutlinedIcon>
  );
}

export function MoreVerticalIcon(props: IconProps) {
  return (
    <OutlinedIcon {...props}>
      <circle cx="12" cy="12" r="1" /><circle cx="12" cy="5" r="1" /><circle cx="12" cy="19" r="1" />
    </OutlinedIcon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <OutlinedIcon {...props}><path d="M20 6 9 17l-5-5" /></OutlinedIcon>
  );
}

export function ChartNoAxesCombinedIcon(props: IconProps) {
  return (
    <OutlinedIcon {...props}>
      <path d="M12 16v5" /><path d="M16 14.639V21" /><path d="M20 10.656V21" /><path d="m22 3-8.646 8.646a.5.5 0 0 1-.708 0L9.354 8.354a.5.5 0 0 0-.707 0L2 15" /><path d="M4 18.463V21" /><path d="M8 14.656V21" />
    </OutlinedIcon>
  );
}

export function AsteriskIcon(props: IconProps) {
  return (
    <OutlinedIcon {...props}>
      <path d="M12 5v14" />
      <path d="m18.065 8.496-12.125 7" />
      <path d="m5.94 8.504 12.125 7" />
    </OutlinedIcon>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <OutlinedIcon {...props}>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </OutlinedIcon>
  );
}

export function SparkleIcon(props: IconProps) {
  return (
    <OutlinedIcon {...props}>
      <path d="M13.2 3.9 14.82 8.64 19.5 10.2 14.82 11.76 13.2 16.5 11.58 11.76 6.9 10.2 11.58 8.64 13.2 3.9Z" />
      <path d="M6 15 6.78 17.22 9 18 6.78 18.78 6 21 5.22 18.78 3 18 5.22 17.22 6 15Z" />
    </OutlinedIcon>
  );
}

export function FilePlusIcon(props: IconProps) {
  return <OutlinedIcon {...props}>
    <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" /><path d="M14 2v5a1 1 0 0 0 1 1h5" /><path d="M9 15h6" /><path d="M12 18v-6" />
  </OutlinedIcon>;
}

export function FileAddIcon(props: IconProps) {
  return <OutlinedIcon {...props}>
    <path d="M13 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-8" />
    <path d="M12 7 13.28 10.72 17 12 13.28 13.28 12 17 10.72 13.28 7 12 10.72 10.72 12 7Z" />
    <path d="M19.5 2 20.15 3.85 22 4.5 20.15 5.15 19.5 7 18.85 5.15 17 4.5 18.85 3.85 19.5 2Z" />
  </OutlinedIcon>;
}

export function FileDeleteIcon(props: IconProps) {
  return <OutlinedIcon {...props}>
    <path d="M5 3a2 2 0 0 0-2 2" /><path d="M19 3a2 2 0 0 1 2 2" /><path d="M21 19a2 2 0 0 1-2 2" /><path d="M5 21a2 2 0 0 1-2-2" />
    <path d="M9 3h1" /><path d="M9 21h1" /><path d="M14 3h1" /><path d="M14 21h1" /><path d="M3 9v1" /><path d="M21 9v1" /><path d="M3 14v1" /><path d="M21 14v1" />
    <path d="m15 9-6 6" /><path d="m9 9 6 6" />
  </OutlinedIcon>;
}

export function FileMoveIcon(props: IconProps) {
  return <OutlinedIcon {...props}>
    <rect width="18" height="18" x="3" y="3" rx="2" /><path d="M8 12h8" /><path d="m12 16 4-4-4-4" />
  </OutlinedIcon>;
}

export function SendHorizontalIcon(props: IconProps) {
  return <OutlinedIcon {...props}>
    <path d="M3.714 3.048a.498.498 0 0 0-.683.627L5 10l5.4 1.5q1.8.5 0 1L5 14l-1.968 6.325a.498.498 0 0 0 .682.627l18-8.5a.5.5 0 0 0 0-.904z" />
  </OutlinedIcon>;
}

export function SquareIcon(props: IconProps) {
  return <OutlinedIcon {...props}>
    <rect width="18" height="18" x="3" y="3" rx="2" />
  </OutlinedIcon>;
}

export function EyeOffIcon(props: IconProps) {
  return <OutlinedIcon {...props}>
    <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" /><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" /><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" /><path d="m2 2 20 20" />
  </OutlinedIcon>;
}

export function ExternalLinkIcon(props: IconProps) {
  return <OutlinedIcon {...props}>
    <path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  </OutlinedIcon>;
}

export function SearchIcon(props: IconProps) {
  return <OutlinedIcon {...props}>
    <path d="m21 21-4.34-4.34" /><circle cx="11" cy="11" r="8" />
  </OutlinedIcon>;
}

export function ChevronDownIcon(props: IconProps) {
  return <OutlinedIcon {...props}><path d="m6 9 6 6 6-6" /></OutlinedIcon>;
}

export function ChevronUpIcon(props: IconProps) {
  return <OutlinedIcon {...props}><path d="m18 15-6-6-6 6" /></OutlinedIcon>;
}

export function CompactIcon(props: IconProps) {
  return <OutlinedIcon {...props}>
    <path d="M4 3H2" /><path d="M10 3H8" /><path d="M16 3h-2" /><path d="M22 3h-2" />
    <path d="m18 13-6-6-6 6" /><path d="M12 7v14" />
  </OutlinedIcon>;
}

export function QuestionnaireListIcon(props: IconProps) {
  return <OutlinedIcon {...props}>
    <path d="M3 5h.01" /><path d="M3 12h.01" /><path d="M3 19h.01" />
    <path d="M8 5h13" /><path d="M8 12h13" /><path d="M8 19h7" />
  </OutlinedIcon>;
}

export function EllipsisIcon(props: IconProps) {
  return <OutlinedIcon {...props}><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></OutlinedIcon>;
}

export function FeatherIcon(props: IconProps) {
  return <OutlinedIcon {...props}>
    <path d="M14.086 18.412A2 2 0 0 1 12.67 19H5v-7.672a2 2 0 0 1 .586-1.414L11.75 3.75a6 6 0 1 1 8.49 8.49z" />
    <path d="M16 8 2 22" /><path d="M17.488 15H9" />
  </OutlinedIcon>;
}

export function FoldWorkedRunIcon(props: IconProps) {
  return <OutlinedIcon {...props}>
    <path d="M12 22v-6" /><path d="M12 8V2" /><path d="M4 12H2" /><path d="M10 12H8" /><path d="M16 12h-2" /><path d="M22 12h-2" /><path d="m15 19-3-3-3 3" /><path d="m15 5-3 3-3-3" />
  </OutlinedIcon>;
}

export function UnfoldWorkedRunIcon(props: IconProps) {
  return <OutlinedIcon {...props}>
    <path d="M12 22v-6" /><path d="M12 8V2" /><path d="M4 12H2" /><path d="M10 12H8" /><path d="M16 12h-2" /><path d="M22 12h-2" /><path d="m15 19-3 3-3-3" /><path d="m15 5-3-3-3 3" />
  </OutlinedIcon>;
}

export function ReapplyTitleIcon(props: IconProps) {
  return <OutlinedIcon {...props}><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11" /></OutlinedIcon>;
}

export function TitleCommandIcon(props: IconProps) {
  return <OutlinedIcon {...props}><path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528" /></OutlinedIcon>;
}

export function GitArcClaimIcon(props: IconProps) {
  return <FlagIcon {...props} />;
}

export function GitArcCleanClaimIcon(props: IconProps) {
  return <OutlinedIcon {...props}>
    <path d="M11 2v2" /><path d="M12 3h-2" /><path d="M13.5 10.5 22 2" /><path d="M14.734 13.841a2 2 0 0 0-.314-2.42L12.58 9.58a2 2 0 0 0-2.421-.314l-7.657 4.461A1 1 0 0 0 2.3 15.3l6.403 6.403a1 1 0 0 0 1.571-.204z" /><path d="M20 15v4" /><path d="M22 17h-4" /><path d="M4 4v4" /><path d="m5 18 2-2" /><path d="M6 6H2" /><path d="m7.699 10.7 5.602 5.601" />
  </OutlinedIcon>;
}

export function GitArcDirtyClaimIcon(props: IconProps) {
  return <OutlinedIcon {...props}>
    <path d="M13.5 10.5 22 2" /><path d="M14.734 13.841a2 2 0 0 0-.314-2.42L12.58 9.58a2 2 0 0 0-2.421-.314l-7.657 4.461A1 1 0 0 0 2.3 15.3l6.403 6.403a1 1 0 0 0 1.571-.204z" /><path d="m5 18 2-2" /><path d="m7.699 10.7 5.602 5.601" />
  </OutlinedIcon>;
}

export function GitArcPlannedClaimIcon(props: IconProps) {
  return <OutlinedIcon {...props}>
    <path d="M6 6V3l2.7 1.3" /><path d="m11.15 5.48 2.7 1.3" /><path d="m16.3 7.95 2.7 1.3-2.7 1.3" /><path d="m13.85 11.73-2.7 1.3" /><path d="m8.7 14.2-2.7 1.3v-3" /><path d="M6 9.78V8.72" /><path d="M6 22v-3.75" />
  </OutlinedIcon>;
}

export function GitArcUnclaimedIcon(props: IconProps) {
  return <OutlinedIcon {...props}>
    <path d="M7.5 22V7.5" />
    <path d="m12.83 12.83-5.33 2.67" />
    <path d="m2 2 20 20" />
    <path d="M7.5 2 20.05 7.78a.8.8 0 0 1 0 1.44l-3.75 1.88" />
  </OutlinedIcon>;
}

export function GitArcConflictIcon(props: IconProps) {
  return <OutlinedIcon {...props}><rect height="18" rx="2" ry="2" width="18" x="3" y="3" /><path d="m15 9-6 6" /><path d="m9 9 6 6" /></OutlinedIcon>;
}

export function GitArcWaitIcon(props: IconProps) {
  return <OutlinedIcon {...props}><path d="M5 22h14" /><path d="M5 2h14" /><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22" /><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2" /></OutlinedIcon>;
}

export function GitArcIcon({ action, ...props }: IconProps & { action: GitArcCommandAction }) {
  if (action === "plan" || action === "scope" || action === "status") {
    return <OutlinedIcon {...props}><path d="M14 21h1" /><path d="M14 3h1" /><path d="M19 3a2 2 0 0 1 2 2" /><path d="M21 14v1" /><path d="M21 19a2 2 0 0 1-2 2" /><path d="M21 9v1" /><path d="M3 14v1" /><path d="M3 9v1" /><path d="M5 21a2 2 0 0 1-2-2" /><path d="M5 3a2 2 0 0 0-2 2" /><path d="M7 12h10" /><path d="M7 16h6" /><path d="M7 8h8" /><path d="M9 21h1" /><path d="M9 3h1" /></OutlinedIcon>;
  }
  if (action === "start" || action === "continue" || action === "planStart") {
    return <OutlinedIcon {...props}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 9.003a1 1 0 0 1 1.517-.859l4.997 2.997a1 1 0 0 1 0 1.718l-4.997 2.997A1 1 0 0 1 9 14.996z" /></OutlinedIcon>;
  }
  if (action === "claims" || action === "release") {
    return <OutlinedIcon {...props}><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M8 12h8" />{action === "claims" ? <path d="M12 8v8" /> : null}</OutlinedIcon>;
  }
  if (action === "mv") return <FileMoveIcon {...props} />;
  if (action === "propose" || action === "rescind" || action === "unknown") {
    return <OutlinedIcon {...props}><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M7 8h8" /><path d="M7 12h10" /><path d="M7 16h6" /></OutlinedIcon>;
  }
  if (action === "compare" || action === "diff") {
    return <OutlinedIcon {...props}><path d="M16 12v2a2 2 0 0 1-2 2H9a1 1 0 0 0-1 1v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2h0" /><path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3a1 1 0 0 1-1 1h-5a2 2 0 0 0-2 2v2" /></OutlinedIcon>;
  }
  return <OutlinedIcon {...props}><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M10.125 13.25 7 10.125l3.125-3.125" /><path d="M7 10.125h6.5625a3.4375 3.4375 0 0 1 3.4375 3.4375A3.4375 3.4375 0 0 1 13.5625 17H11.375" /></OutlinedIcon>;
}

export const BinIcon = Trash2Icon;
export const SidebarCollapseIcon = PanelLeftCloseIcon;
export const SidebarExpandIcon = PanelLeftOpenIcon;
export const PanelMinimizeIcon = SquareMinusIcon;
export const PanelExpandIcon = SquarePlusIcon;
export const PanelCloseIcon = XIcon;
export const GearIcon = SettingsIcon;
export const ProjectIcon = FolderGit2Icon;
export const BrowserSessionIcon = AppWindowIcon;
export const ReloadIcon = RefreshCwIcon;
export const StopIcon = SquareIcon;
export const WarningIcon = TriangleAlertIcon;
export const DraftThreadIcon = MessageCircleDashedIcon;
export const ComposerDraftIcon = SquarePenIcon;
export const NeedsAttentionThreadIcon = MessageCircleQuestionMarkIcon;
export const CompletedThreadIcon = MessageCircleCheckIcon;
export const ProposedCommitThreadIcon = MessageCircleGitCommitIcon;
export const WorkingThreadIcon = MessageCircleMoreIcon;
export const StoppedThreadIcon = MessageCircleXIcon;
export const DiscardDraftIcon = XIcon;
export const SettleThreadIcon = CheckCheckIcon;
export const RestoreThreadIcon = ArrowUpIcon;
export const UnsnoozeThreadIcon = AlarmClockIcon;
export const SnoozedThreadIcon = ZzzIcon;
export const OpenThreadIcon = ArrowRightIcon;
export const PreviewIcon = EyeIcon;
export const StatsIcon = ChartNoAxesCombinedIcon;
export const FileUpdateIcon = SquarePenIcon;
