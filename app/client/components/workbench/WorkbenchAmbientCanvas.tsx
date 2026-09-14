"use client";

/*
 * Exports:
 * - WorkbenchAmbientCanvasVariant: supported ambient canvas theme variants. Keywords: theme, variant, ambient.
 * - default WorkbenchAmbientCanvas: reusable animated theme background canvas. Keywords: theme, canvas, sparkles, snow, ambient.
 */
import { useEffect, useRef } from "react";

export type WorkbenchAmbientCanvasVariant = "magical-girl" | "winter";

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

function getParticleCount(width: number, height: number, preset: AmbientPreset) {
  const area = width * height;
  return Math.min(preset.maxCount, Math.max(preset.minCount, Math.floor(area / preset.countDivisor)));
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

function createParticles(
  width: number,
  height: number,
  colorCount: number,
  timestamp: number,
  variant: WorkbenchAmbientCanvasVariant,
): Particle[] {
  const preset = AMBIENT_PRESETS[variant];
  return Array.from({ length: getParticleCount(width, height, preset) }, () => (
    createParticle(width, height, colorCount, timestamp, true, variant)
  ));
}

function readCanvasColors(variant: WorkbenchAmbientCanvasVariant) {
  const preset = AMBIENT_PRESETS[variant];
  if (preset.colorSource === "preset") {
    return preset.colors;
  }

  const styles = window.getComputedStyle(document.documentElement);
  const accent = styles.getPropertyValue("--accent").trim() || "#ff86d5";
  const text = styles.getPropertyValue("--text").trim() || "#ffe4f6";
  const selection = styles.getPropertyValue("--selection").trim() || "#ff86d54d";
  return [accent, text, selection, ...preset.colors];
}

function getParticleFrame(particle: Particle, timestamp: number) {
  const age = Math.max(0, timestamp - particle.bornAt);
  const phase = Math.min(1, age / particle.duration);
  const fadePortion = 0.28;
  const fadeIn = Math.min(1, phase / fadePortion);
  const fadeOut = Math.min(1, (1 - phase) / fadePortion);
  const opacity = Math.max(0, Math.min(fadeIn, fadeOut)) * particle.maxOpacity;
  const ageSeconds = age / 1000;
  const x = particle.x + particle.vx * ageSeconds + Math.sin(ageSeconds * 0.55 + particle.x) * 2.4;
  const y = particle.y + particle.vy * ageSeconds;

  return { opacity, x, y };
}

function drawSparkle(context: CanvasRenderingContext2D, particle: Particle, color: string, timestamp: number) {
  const frame = getParticleFrame(particle, timestamp);
  const radius = particle.radius * (0.76 + frame.opacity * 0.75);

  context.save();
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
  context.restore();
}

function drawSnow(context: CanvasRenderingContext2D, particle: Particle, color: string, timestamp: number) {
  const frame = getParticleFrame(particle, timestamp);

  context.save();
  context.globalAlpha = frame.opacity;
  context.fillStyle = color;
  context.beginPath();
  context.arc(frame.x, frame.y, particle.radius, 0, Math.PI * 2);
  context.fill();
  context.globalAlpha = frame.opacity * 0.32;
  context.beginPath();
  context.arc(frame.x, frame.y, particle.radius * 2.2, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

export default function WorkbenchAmbientCanvas({ variant }: { variant: WorkbenchAmbientCanvasVariant }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    const preset = AMBIENT_PRESETS[variant];
    let animationFrameId = 0;
    let particles: Particle[] = [];
    let colors = readCanvasColors(variant);
    let width = 0;
    let height = 0;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    const resizeCanvas = () => {
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, window.innerWidth);
      height = Math.max(1, window.innerHeight);
      canvas.width = Math.floor(width * pixelRatio);
      canvas.height = Math.floor(height * pixelRatio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      colors = readCanvasColors(variant);
      particles = createParticles(width, height, colors.length, window.performance.now(), variant);
    };

    const drawParticle = (particle: Particle, timestamp: number) => {
      const color = colors[particle.colorIndex % colors.length];
      if (preset.draw === "snow") {
        drawSnow(context, particle, color, timestamp);
        return;
      }

      drawSparkle(context, particle, color, timestamp);
    };

    const renderFrame = (timestamp: number) => {
      context.clearRect(0, 0, width, height);
      colors = readCanvasColors(variant);
      for (let index = 0; index < particles.length; index += 1) {
        const particle = particles[index];
        const age = timestamp - particle.bornAt;
        if (!reducedMotion.matches && age > particle.duration) {
          particles[index] = createParticle(width, height, colors.length, timestamp, false, variant);
        }
        drawParticle(particles[index], timestamp);
      }

      if (!reducedMotion.matches) {
        animationFrameId = window.requestAnimationFrame(renderFrame);
      }
    };

    const handleResize = () => {
      resizeCanvas();
      renderFrame(window.performance.now());
    };

    resizeCanvas();
    renderFrame(window.performance.now());
    if (!reducedMotion.matches) {
      animationFrameId = window.requestAnimationFrame(renderFrame);
    }

    window.addEventListener("resize", handleResize);
    reducedMotion.addEventListener("change", handleResize);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
      window.removeEventListener("resize", handleResize);
      reducedMotion.removeEventListener("change", handleResize);
    };
  }, [variant]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10 opacity-70"
    />
  );
}
