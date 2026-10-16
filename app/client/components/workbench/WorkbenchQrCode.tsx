/* Default export: WorkbenchQrCode renders a local QR in the current text colour on a transparent ground, with its required quiet zone. */
import { useMemo } from "react";
import QRCode from "qrcode";

export default function WorkbenchQrCode({ text, className = "size-40" }: { text: string; className?: string }) {
  const code = useMemo(() => {
    const { modules } = QRCode.create(text, { errorCorrectionLevel: "M" });
    const path: string[] = [];
    for (let row = 0; row < modules.size; row++) {
      for (let column = 0; column < modules.size; column++) {
        if (modules.get(row, column)) path.push(`M${column + 4} ${row + 4}h1v1h-1z`);
      }
    }
    return { size: modules.size + 8, path: path.join("") };
  }, [text]);
  return <svg viewBox={`0 0 ${code.size} ${code.size}`} className={`shrink-0 text-text ${className}`} role="img"
    aria-label="Scan to open the tailnet IP address" shapeRendering="crispEdges">
    <path d={code.path} fill="currentColor" />
  </svg>;
}
