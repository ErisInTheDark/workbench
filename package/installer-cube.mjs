/*
 * Exports:
 * - INSTALLER_CUBE_ROWS: largest and smallest cube heights worth drawing, in terminal rows.
 * - installerCubeWidth: terminal columns a cube frame of the given height occupies.
 * - renderInstallerCube: raycast one antialiased ASCII frame of the spinning installer cube.
 */

export const INSTALLER_CUBE_ROWS = Object.freeze({ max: 21, min: 11 });

// Terminal cells are roughly twice as tall as they are wide.
const CELL_ASPECT = 2.05;
const RAMP = " .:-=+*#%@";
const SAMPLES = 4;
const TILT = 0.35;
const SPIN = 0.8;
const START = 0.35;
const CAMERA = 5.2;
const FOCAL = 2.9;
const BORDER = 0.1;
const STROKE = 0.09;
const DOT = 0.12;
const TOP_FILL = 0.4;

// Face glyphs live in face space: u to the right and v up when the face is viewed from outside.
const GLYPHS = {
  check: { strokes: [[[-0.45, 0], [-0.12, -0.38], [0.48, 0.42]]], dots: [] },
  x: { strokes: [[[-0.42, -0.42], [0.42, 0.42]], [[-0.42, 0.42], [0.42, -0.42]]], dots: [] },
  question: {
    strokes: [[[-0.32, 0.22], [-0.22, 0.42], [0, 0.5], [0.22, 0.42], [0.32, 0.22], [0.22, 0.06], [0, -0.04], [0, -0.18]]],
    dots: [[0, -0.42]],
  },
  dots: { strokes: [], dots: [[-0.42, 0], [0, 0], [0.42, 0]] },
};

// Indexed by axis then sign: [x-, x+], [y-, y+], [z-, z+]. Each basis satisfies u x v = normal.
const FACES = [
  [{ u: [0, 0, 1], v: [0, 1, 0], glyph: GLYPHS.dots }, { u: [0, 0, -1], v: [0, 1, 0], glyph: GLYPHS.question }],
  [{ u: [1, 0, 0], v: [0, 0, 1], glyph: null }, { u: [1, 0, 0], v: [0, 0, -1], glyph: null, fill: TOP_FILL }],
  [{ u: [-1, 0, 0], v: [0, 1, 0], glyph: GLYPHS.x }, { u: [1, 0, 0], v: [0, 1, 0], glyph: GLYPHS.check }],
];

export function installerCubeWidth(rows) {
  return Math.round(rows * 2.2);
}

function segmentDistance(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function glyphCovers(glyph, u, v) {
  for (const stroke of glyph.strokes) {
    for (let index = 1; index < stroke.length; index++) {
      if (segmentDistance(u, v, stroke[index - 1], stroke[index]) < STROKE) return true;
    }
  }
  return glyph.dots.some(([x, y]) => Math.hypot(u - x, v - y) < DOT);
}

/** Brightness 0..1 where a camera ray through (px, py) meets the cube, given world-to-object rotation. */
function shade(toObject, origin, px, py) {
  const direction = toObject(px / FOCAL, py / FOCAL, -1);
  let near = -Infinity, far = Infinity, axis = -1, side = 0;
  for (let index = 0; index < 3; index++) {
    let enter = (-1 - origin[index]) / direction[index];
    let leave = (1 - origin[index]) / direction[index];
    let entered = 0;
    if (enter > leave) { [enter, leave] = [leave, enter]; entered = 1; }
    if (enter > near) { near = enter; axis = index; side = entered; }
    if (leave < far) far = leave;
  }
  if (near > far || far < 0) return 0;
  const face = FACES[axis][side];
  const x = origin[0] + direction[0] * near, y = origin[1] + direction[1] * near, z = origin[2] + direction[2] * near;
  const u = x * face.u[0] + y * face.u[1] + z * face.u[2];
  const v = x * face.v[0] + y * face.v[1] + z * face.v[2];
  if (1 - Math.max(Math.abs(u), Math.abs(v)) < BORDER) return 1;
  if (face.fill) return face.fill;
  return face.glyph && glyphCovers(face.glyph, u, v) ? 0.95 : 0;
}

/** One frame: exactly `rows` strings of exactly installerCubeWidth(rows) printable ASCII characters. */
export function renderInstallerCube(seconds, rows = INSTALLER_CUBE_ROWS.max) {
  const width = installerCubeWidth(rows);
  const spin = START + seconds * SPIN;
  const cs = Math.cos(spin), ss = Math.sin(spin), ct = Math.cos(TILT), st = Math.sin(TILT);
  // Undo the tilt about X, then the spin about Y.
  const toObject = (x, y, z) => {
    const ty = y * ct + z * st, tz = -y * st + z * ct;
    return [x * cs - tz * ss, ty, x * ss + tz * cs];
  };
  const origin = toObject(0, 0, CAMERA);
  const lines = [];
  for (let row = 0; row < rows; row++) {
    let line = "";
    for (let column = 0; column < width; column++) {
      let coverage = 0;
      for (let j = 0; j < SAMPLES; j++) {
        // Nudge the view up slightly so the cube sits centred rather than low in its box.
        const py = -(row + (j + 0.5) / SAMPLES - rows / 2) / (rows / 2) - 0.12;
        for (let i = 0; i < SAMPLES; i++) {
          const px = (column + (i + 0.5) / SAMPLES - width / 2) / (rows * CELL_ASPECT / 2);
          coverage += shade(toObject, origin, px, py);
        }
      }
      const level = Math.pow(coverage / (SAMPLES * SAMPLES), 0.75);
      line += RAMP[Math.min(RAMP.length - 1, Math.round(level * (RAMP.length - 1)))];
    }
    lines.push(line);
  }
  return lines;
}
