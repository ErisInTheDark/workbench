/*
 * Exports:
 * - WorkbenchAmbientCanvasVariant: supported ambient canvas theme variants.
 * - WorkbenchAmbientCanvasDensity: the app backdrop, or a small preview such as a theme swatch.
 * - getAmbientCanvasVariant: the ambient canvas a theme shows, if any.
 * - default WorkbenchAmbientCanvas: animated theme particles filling the parent box, coloured by the theme in scope where it renders.
 */
"use client";
import { useEffect, useRef } from "react";
import type { WorkbenchTheme } from "workbench-shared/workbench/settings/workbench-setting-definitions";

export type WorkbenchAmbientCanvasVariant = "magical-girl" | "winter";
export type WorkbenchAmbientCanvasDensity = "backdrop" | "preview";

type Particle = {
  bornAt: number;
  colorIndex: number;
  duration: number;
  maxOpacity: number;
  radius: number;
  vx: number;
  vy: number;
  x: number;
  y: number;
};

type AmbientPreset = {
  colorSource: "theme" | "preset";
  colors: string[];
  countDivisor: number;
  draw: "snow" | "sparkle";
  maxCount: number;
  minCount: number;
};

/** How densely and brightly particles fill a box; previews are small, so they need far more per area to read. */
type AmbientDensity = {
  countScale: number;
  maxCount: number | null;
  minCount: number | null;
  opacityScale: number;
  /** Small boxes wrap drift vertically so particles stay visible for their whole life. */
  wrap: boolean;
};

const AMBIENT_PRESETS: Record<WorkbenchAmbientCanvasVariant, AmbientPreset> = {
  "magical-girl": {
    colorSource: "theme",
    colors: ["#ffd7f0", "#d9c7ff", "#fff8fd"],
    countDivisor: 14000,
    draw: "sparkle",
    maxCount: 132,
    minCount: 38,
  },
  winter: {
    colorSource: "preset",
    colors: ["#ffffff", "#fbfdff", "#f1f8ff"],
    countDivisor: 12500,
    draw: "snow",
    maxCount: 150,
    minCount: 42,
  },
};

const AMBIENT_DENSITIES: Record<WorkbenchAmbientCanvasDensity, AmbientDensity> = {
  backdrop: { countScale: 1, maxCount: null, minCount: null, opacityScale: 1, wrap: false },
  preview: { countScale: 5.5, maxCount: 60, minCount: 12, opacityScale: 2.2, wrap: true },
};

export function getAmbientCanvasVariant(theme: WorkbenchTheme): WorkbenchAmbientCanvasVariant | null {
  return theme === "magical-girl" || theme === "winter" ? theme : null;
}

/** Theme colours are computed styles; reading them every frame forces a style recalc, so they refresh at this pace. */
const COLOR_REFRESH_MS = 500;

function getParticleCount(width: number, height: number, preset: AmbientPreset, density: AmbientDensity) {
  const count = Math.floor((width * height * density.countScale) / preset.countDivisor);
  return Math.min(density.maxCount ?? preset.maxCount, Math.max(density.minCount ?? preset.minCount, count));
}

function createParticle(
  width: number,
  height: number,
  colorCount: number,
  timestamp: number,
  randomizeAge: boolean,
  variant: WorkbenchAmbientCanvasVariant,
): Particle {
  const isWinter = variant === "winter";
  const duration = isWinter ? 8200 + Math.random() * 9200 : 6200 + Math.random() * 7800;
  const isBrightAccent = isWinter ? Math.random() > 0.74 : Math.random() > 0.82;
  const speedBoost = Math.random() > 0.84 ? 1.07 : 1;

  return {
    bornAt: timestamp - (randomizeAge ? Math.random() * duration : 0),
    colorIndex: Math.floor(Math.random() * colorCount),
    duration,
    maxOpacity: isWinter
      ? isBrightAccent ? 0.22 + Math.random() * 0.12 : 0.075 + Math.random() * 0.13
      : isBrightAccent ? 0.24 + Math.random() * 0.16 : 0.055 + Math.random() * 0.13,
    radius: isWinter ? 0.85 + Math.random() * 1.85 : 0.58 + Math.random() * 1.15,
    vx: isWinter ? -2.4 + Math.random() * 4.8 : -1.8 + Math.random() * 3.6,
    vy: (isWinter ? 4.4 + Math.random() * 9.4 : 3.2 + Math.random() * 8.8) * speedBoost,
    x: Math.random() * width,
    y: Math.random() * height,
  };
}

/** Theme colours resolve from the canvas itself, so a swatch inside `data-workbench-theme-preview` sparkles in its own theme. */
function readCanvasColors(canvas: HTMLCanvasElement, variant: WorkbenchAmbientCanvasVariant) {
  const preset = AMBIENT_PRESETS[variant];
  if (preset.colorSource === "preset") {
    return preset.colors;
  }

  const styles = window.getComputedStyle(canvas);
  const accent = styles.getPropertyValue("--accent").trim() || "#ff86d5";
  const text = styles.getPropertyValue("--text").trim() || "#ffe4f6";
  const selection = styles.getPropertyValue("--selection").trim() || "#ff86d54d";
  return [accent, text, selection, ...preset.colors];
}

function getParticleFrame(particle: Particle, timestamp: number, height: number, density: AmbientDensity) {
  const age = Math.max(0, timestamp - particle.bornAt);
  const phase = Math.min(1, age / particle.duration);
  const fadePortion = 0.28;
  const fadeIn = Math.min(1, phase / fadePortion);
  const fadeOut = Math.min(1, (1 - phase) / fadePortion);
  const opacity = Math.min(1, Math.max(0, Math.min(fadeIn, fadeOut)) * particle.maxOpacity * density.opacityScale);
  const ageSeconds = age / 1000;
  const x = particle.x + particle.vx * ageSeconds + Math.sin(ageSeconds * 0.55 + particle.x) * 2.4;
  const y = particle.y + particle.vy * ageSeconds;

  return { opacity, x, y: density.wrap ? y % (height + 8) : y };
}

function drawSparkle(context: CanvasRenderingContext2D, color: string, frame: { opacity: number; x: number; y: number }, baseRadius: number) {
  const radius = baseRadius * (0.76 + frame.opacity * 0.75);

  context.globalAlpha = frame.opacity;
  context.strokeStyle = color;
  context.lineWidth = 1.1;
  context.beginPath();
  context.moveTo(frame.x - radius * 2.2, frame.y);
  context.lineTo(frame.x + radius * 2.2, frame.y);
  context.moveTo(frame.x, frame.y - radius * 2.2);
  context.lineTo(frame.x, frame.y + radius * 2.2);
  context.stroke();
  context.globalAlpha = frame.opacity * 0.5;
  context.beginPath();
  context.arc(frame.x, frame.y, radius * 0.62, 0, Math.PI * 2);
  context.fillStyle = color;
  context.fill();
}

function drawSnow(context: CanvasRenderingContext2D, color: string, frame: { opacity: number; x: number; y: number }, radius: number) {
  context.globalAlpha = frame.opacity;
  context.fillStyle = color;
  context.beginPath();
  context.arc(frame.x, frame.y, radius, 0, Math.PI * 2);
  context.fill();
  context.globalAlpha = frame.opacity * 0.32;
  context.beginPath();
  context.arc(frame.x, frame.y, radius * 2.2, 0, Math.PI * 2);
  context.fill();
}

export default function WorkbenchAmbientCanvas({
  className = "",
  density: densityName = "backdrop",
  variant,
}: {
  className?: string;
  density?: WorkbenchAmbientCanvasDensity;
  variant: WorkbenchAmbientCanvasVariant;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const box = canvas?.parentElement;
    const context = canvas?.getContext("2d");
    if (!canvas || !box || !context) {
      return;
    }

    const preset = AMBIENT_PRESETS[variant];
    const density = AMBIENT_DENSITIES[densityName];
    let animationFrameId = 0;
    let particles: Particle[] = [];
    let colors = readCanvasColors(canvas, variant);
    let colorsReadAt = window.performance.now();
    let width = 0;
    let height = 0;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    const resizeCanvas = () => {
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, box.clientWidth);
      height = Math.max(1, box.clientHeight);
      canvas.width = Math.floor(width * pixelRatio);
      canvas.height = Math.floor(height * pixelRatio);
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      colors = readCanvasColors(canvas, variant);
      const now = window.performance.now();
      colorsReadAt = now;
      particles = Array.from({ length: getParticleCount(width, height, preset, density) }, () => (
        createParticle(width, height, colors.length, now, true, variant)
      ));
    };

    const renderFrame = (timestamp: number) => {
      animationFrameId = 0;
      context.clearRect(0, 0, width, height);
      if (timestamp - colorsReadAt >= COLOR_REFRESH_MS) {
        colors = readCanvasColors(canvas, variant);
        colorsReadAt = timestamp;
      }
      const moving = !reducedMotion.matches;
      for (let index = 0; index < particles.length; index += 1) {
        if (moving && timestamp - particles[index]!.bornAt > particles[index]!.duration) {
          particles[index] = createParticle(width, height, colors.length, timestamp, false, variant);
        }
        const particle = particles[index]!;
        const color = colors[particle.colorIndex % colors.length]!;
        const frame = getParticleFrame(particle, timestamp, height, density);
        if (preset.draw === "snow") drawSnow(context, color, frame, particle.radius);
        else drawSparkle(context, color, frame, particle.radius);
      }

      if (moving) {
        animationFrameId = window.requestAnimationFrame(renderFrame);
      }
    };

    const restart = () => {
      window.cancelAnimationFrame(animationFrameId);
      resizeCanvas();
      renderFrame(window.performance.now());
    };

    const resizeObserver = new ResizeObserver(restart);
    resizeObserver.observe(box);
    reducedMotion.addEventListener("change", restart);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
      resizeObserver.disconnect();
      reducedMotion.removeEventListener("change", restart);
    };
  }, [densityName, variant]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 size-full ${className}`}
    />
  );
}
