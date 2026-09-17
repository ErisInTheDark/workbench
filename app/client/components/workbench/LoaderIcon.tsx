/* Exports:
 * - default LoaderIcon: continuously spinning loader with non-repeating random motions.
 */
"use client";

import { useEffect, useRef } from "react";
import LoaderAnimationController from "./LoaderAnimationController";
import OutlinedIcon, { type IconProps } from "./OutlinedIcon";

const spokes = ["M12 2v4", "m16.2 7.8 2.9-2.9", "M18 12h4", "m16.2 16.2 2.9 2.9", "M12 18v4", "m4.9 19.1 2.9-2.9", "M2 12h4", "m4.9 4.9 2.9 2.9"];
const midpoints = ["12px 4px", "17.65px 6.35px", "20px 12px", "17.65px 17.65px", "12px 20px", "6.35px 17.65px", "4px 12px", "6.35px 6.35px"];

export default function LoaderIcon(props: IconProps) {
  const group = useRef<SVGGElement>(null);
  const brake = useRef<SVGGElement>(null);
  const jitter = useRef<SVGGElement>(null);
  useEffect(() => {
    const element = group.current;
    const brakeElement = brake.current;
    const jitterElement = jitter.current;
    if (!element || !brakeElement || !jitterElement) return;
    const paths = element.querySelectorAll("path");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let controller: LoaderAnimationController | null = null;
    const update = () => {
      controller?.dispose();
      controller = null;
      if (reducedMotion.matches) return;
      controller = new LoaderAnimationController((target, frames, options) => {
        const node = target === "spin" ? element
          : target === "brake" ? brakeElement
          : target === "jitter" ? jitterElement
          : typeof target === "object" ? ("rotation" in target ? jitterElement.children[target.rotation]! : paths[target.selfRotation]!)
          : target === "traveller" ? paths[8]!
          : jitterElement.children[target]!.firstElementChild!;
        return node.animate(frames, options);
      });
      controller.start();
    };
    update();
    reducedMotion.addEventListener("change", update);
    return () => {
      reducedMotion.removeEventListener("change", update);
      controller?.dispose();
    };
  }, []);

  return <OutlinedIcon {...props} viewportPadding={2}>
    {/* Keep rotation coordinates independent of the outer bounce clearance. */}
    <svg x={0} y={0} width={24} height={24} viewBox="0 0 24 24" overflow="visible">
      <g ref={group} style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
        <g ref={brake} style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
          <g ref={jitter} style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
            {spokes.map((path, index) => (
              <g key={path} style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
                <g>
                  <path d={path} style={{ transformBox: "view-box", transformOrigin: midpoints[index] }} />
                </g>
              </g>
            ))}
            <path d={spokes[0]} style={{ opacity: 0, transformBox: "view-box", transformOrigin: "12px 12px" }} />
          </g>
        </g>
      </g>
    </svg>
  </OutlinedIcon>;
}
