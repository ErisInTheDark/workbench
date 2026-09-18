/*
 * Exports:
 * - default VoiceAudioRecording: ordered local PCM retention and WAV finalisation.
 */
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";

export default class VoiceAudioRecording {
  private file: FileHandle | null = null;
  private bytes = 0;
  private writes: Promise<void>;
  private closing: Promise<void> | null = null;

  constructor(directory: string) {
    this.writes = fs.open(path.join(directory, "audio.wav"), "wx").then(async file => {
      this.file = file;
      await this.write(this.header(), 0);
    });
  }

  prepare() { return this.writes; }

  append(pcm: Buffer) {
    if (this.closing) return Promise.reject(new Error("Voice recording has ended."));
    if (!pcm.length || pcm.length > 32000 || pcm.length % 2) return Promise.reject(new Error("Invalid recording PCM frame."));
    this.writes = this.writes.then(async () => {
      if (this.bytes + pcm.length > 0xffffffff - 36) throw new Error("Voice recording exceeds WAV capacity.");
      await this.write(pcm, 44 + this.bytes);
      this.bytes += pcm.length;
    });
    return this.writes;
  }

  close() {
    return this.closing ??= (async () => {
      // Even a failed write must close the handle and preserve the completed prefix.
      try { await this.writes; }
      finally {
        try { if (this.file) await this.write(this.header(), 0); }
        finally { await this.file?.close(); this.file = null; }
      }
    })();
  }

  private header() {
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + this.bytes, 4);
    header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16000, 24);
    header.writeUInt32LE(32000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(this.bytes, 40);
    return header;
  }

  private async write(buffer: Buffer, position: number) {
    if (!this.file) throw new Error("Voice recording is unavailable.");
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesWritten } = await this.file.write(buffer, offset, buffer.length - offset, position + offset);
      if (!bytesWritten) throw new Error("Voice recording write made no progress.");
      offset += bytesWritten;
    }
  }
}
