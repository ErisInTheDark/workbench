/*
 * Exports:
 * - default OpenCodePatchPreview: incrementally decode file-tool arguments into generated target/count snapshots.
 */
import { JSONParser } from "@streamparser/json";
import type { ToolPatchPreviewFile } from "workbench-shared/workbench/thread/tool-patch-preview";

export default class OpenCodePatchPreview {
  private readonly parser: JSONParser;
  private readonly files: ToolPatchPreviewFile[] = [];
  private offset = 0;
  private pendingLine = "";
  private received = 0;
  private changed = false;
  private current: ToolPatchPreviewFile | undefined;

  constructor(private readonly tool: string) {
    this.parser = new JSONParser({
      paths: tool === "patch" ? ["$.patchText"] : ["$.path"],
      keepStack: false,
      emitPartialTokens: true,
      emitPartialValues: true,
    });
    this.parser.onValue = ({ key, value, partial }) => {
      if (typeof value !== "string") return;
      if (tool === "patch" && key === "patchText") {
        const suffix = value.slice(this.offset);
        this.offset = value.length;
        this.pendingLine += suffix;
        let newline: number;
        while ((newline = this.pendingLine.indexOf("\n")) !== -1) {
          this.line(this.pendingLine.slice(0, newline).replace(/\r$/u, ""));
          this.pendingLine = this.pendingLine.slice(newline + 1);
        }
        if (!partial && this.pendingLine) {
          this.line(this.pendingLine.replace(/\r$/u, ""));
          this.pendingLine = "";
        }
      } else if (key === "path" && !partial && value && !this.files.length) {
        this.files.push({ path: value, kind: { type: "update", move_path: null } });
        this.changed = true;
      }
    };
  }

  append(text: string): ToolPatchPreviewFile[] | null {
    this.received += text.length;
    // This bounds observation memory only. The owning transport still forwards every native byte.
    if (this.received > 8 * 1024 * 1024) throw new Error("File preview input exceeds observation capacity.");
    this.changed = false;
    this.parser.write(text);
    return this.changed ? this.files.map(file => ({ ...file, kind: { ...file.kind } })) : null;
  }

  private line(line: string) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/u.exec(line);
    if (header) {
      this.current = {
        path: header[2]!,
        kind: header[1] === "Add" ? { type: "add" }
          : header[1] === "Delete" ? { type: "delete" } : { type: "update", move_path: null },
        ...(header[1] !== "Delete" ? { additions: 0, deletions: 0 } : {}),
      };
      this.files.push(this.current);
      this.changed = true;
      return;
    }
    if (line === "*** End Patch") {
      this.current = undefined;
      return;
    }
    const file = this.current;
    if (!file) return;
    if (line.startsWith("*** Move to: ") && file.kind.type === "update") {
      file.kind.move_path = line.slice("*** Move to: ".length);
      this.changed = true;
    } else if (line.startsWith("+") && file.kind.type !== "delete") {
      file.additions = (file.additions ?? 0) + 1;
      this.changed = true;
    } else if (line.startsWith("-") && file.kind.type === "update") {
      file.deletions = (file.deletions ?? 0) + 1;
      this.changed = true;
    }
  }
}
