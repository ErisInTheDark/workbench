/* Default export: WorkbenchQrCode renders a local, high-contrast QR with its required quiet zone. */
import { useMemo } from "react";
import QRCode from "qrcode";

export default function WorkbenchQrCode({ text }: { text: string }) {
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
  return <svg viewBox={`0 0 ${code.size} ${code.size}`} className="size-40 shrink-0 rounded-lg" role="img" aria-label="Scan to open the tailnet IP address" shapeRendering="crispEdges">
    <rect width={code.size} height={code.size} fill="white" />
    <path d={code.path} fill="black" />
  </svg>;
}
