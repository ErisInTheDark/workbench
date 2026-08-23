/*
 * Exports:
 * - size/contentType: describe the generated mask-safe Workbench application icon. Keywords: workbench, icon, metadata, iOS.
 * - default Icon: generate the full-resolution Workbench application icon without a checked-in raster artifact. Keywords: workbench, icon, ImageResponse, Home Screen.
 */

import { ImageResponse } from "next/og";

export const size = { height: 512, width: 512 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          alignItems: "center",
          background: "linear-gradient(145deg, #10131a 0%, #4c1d95 52%, #be185d 100%)",
          color: "white",
          display: "flex",
          height: "100%",
          justifyContent: "center",
          width: "100%",
        }}
      >
        <div
          style={{
            alignItems: "center",
            border: "18px solid rgba(255, 255, 255, 0.28)",
            borderRadius: 112,
            display: "flex",
            fontSize: 250,
            fontWeight: 800,
            height: 356,
            justifyContent: "center",
            letterSpacing: "-0.12em",
            lineHeight: 1,
            paddingRight: 24,
            width: 356,
          }}
        >
          W
        </div>
      </div>
    ),
    size,
  );
}
