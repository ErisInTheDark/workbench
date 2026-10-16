/*
 * Exports:
 * - default ComposerAttachments: shared image previews with numbered reference handles and removal.
 */
import type { WorkbenchThreadComposerAttachmentDraft } from "workbench-shared/types";
import { attachmentReferenceDragType } from "workbench-shared/workbench/thread/attachment-references";
import ThreadLightboxImage from "./ThreadLightboxImage";
import { XIcon } from "../workbench-icons";

export default function ComposerAttachments({ attachments, compact, disabled, onRemove, onReference }: {
  attachments: readonly WorkbenchThreadComposerAttachmentDraft[];
  compact?: boolean;
  disabled?: boolean;
  onRemove?: (id: string) => void;
  onReference?: (number: number) => void;
}) {
  return <div className="flex flex-wrap gap-3">
    {attachments.map((attachment, index) => <div key={attachment.id} className={`relative ${compact ? "h-16 w-16" : "h-24 w-24"}`}>
      <ThreadLightboxImage alt={`Attached image ${index + 1}`} buttonClassName="h-full w-full rounded-[0.95rem]"
        imageClassName="h-full w-full object-cover" src={attachment.url} />
      <button type="button" disabled={disabled || !onReference} draggable={!disabled && Boolean(onReference)}
        aria-label={`Mention attachment ${index + 1}`} title={`Insert or drag #[attach:${index + 1}]`}
        className="
          absolute top-1.5 left-1.5 z-10 inline-flex h-7 min-w-7 items-center justify-center rounded-full px-1.5
          text-sm font-medium text-black/65 cursor-grab transition
          hover:(bg-[color-mix(in srgb, var(--bg) 82%, transparent)] text-text shadow-sm)
          focus-visible:(bg-[color-mix(in srgb, var(--bg) 82%, transparent)] text-text outline-none ring-2 ring-accent-soft)
          active:cursor-grabbing
        "
        onClick={() => onReference?.(index + 1)}
        onDragStart={event => {
          event.dataTransfer.effectAllowed = "copy";
          event.dataTransfer.setData(attachmentReferenceDragType, String(index + 1));
          event.dataTransfer.setData("text/plain", `#[attach:${index + 1}]`);
        }}>#{index + 1}</button>
      {onRemove && <button type="button" disabled={disabled} aria-label={`Remove attached image ${index + 1}`}
        title="Remove attached image"
        className="absolute top-1.5 right-1.5 z-10 inline-flex h-7 w-7 items-center justify-center rounded-full bg-[color-mix(in srgb, var(--bg) 82%, transparent)] text-text shadow-sm transition hover:bg-[color-mix(in srgb, var(--bg) 92%, transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
        onClick={() => onRemove(attachment.id)}><XIcon size={14} /></button>}
    </div>)}
  </div>;
}
