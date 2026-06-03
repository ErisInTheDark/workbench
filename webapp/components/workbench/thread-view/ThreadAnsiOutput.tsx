/*
 * Exports:
 * - default ThreadAnsiOutput: render terminal text with ANSI SGR formatting while dropping other escape sequences. Keywords: thread, ansi, terminal, command output.
 * - parseAnsiOutput: split terminal text into styled spans after consuming ANSI escape sequences. Keywords: ansi, parser, sgr, escape.
 */
"use client";

import { Fragment, type CSSProperties } from "react";

interface AnsiRenderState {
  backgroundColor: string | null;
  blink: boolean;
  bold: boolean;
  concealed: boolean;
  dim: boolean;
  doubleUnderline: boolean;
  encircled: boolean;
  framed: boolean;
  foregroundColor: string | null;
  inverse: boolean;
  italic: boolean;
  overline: boolean;
  strike: boolean;
  subscript: boolean;
  superscript: boolean;
  underline: boolean;
  underlineColor: string | null;
}

export interface AnsiOutputSpan {
  state: AnsiRenderState;
  text: string;
}

const ESCAPE = "\u001b";
const CSI_8_BIT = "\u009b";
const OSC_8_BIT = "\u009d";
const STRING_TERMINATOR_8_BIT = "\u009c";
const DEFAULT_STATE: AnsiRenderState = {
  backgroundColor: null,
  blink: false,
  bold: false,
  concealed: false,
  dim: false,
  doubleUnderline: false,
  encircled: false,
  framed: false,
  foregroundColor: null,
  inverse: false,
  italic: false,
  overline: false,
  strike: false,
  subscript: false,
  superscript: false,
  underline: false,
  underlineColor: null,
};

const ANSI_STANDARD_COLORS = [
  "#171717",
  "#c01c28",
  "#26a269",
  "#a2734c",
  "#12488b",
  "#a347ba",
  "#2aa1b3",
  "#d0cfcc",
] as const;

const ANSI_BRIGHT_COLORS = [
  "#5e5c64",
  "#f66151",
  "#33d17a",
  "#e9ad0c",
  "#2a7bde",
  "#c061cb",
  "#33c7de",
  "#ffffff",
] as const;

function cloneAnsiState(state: AnsiRenderState): AnsiRenderState {
  return { ...state };
}

function areAnsiStatesEqual(left: AnsiRenderState, right: AnsiRenderState) {
  return left.backgroundColor === right.backgroundColor
    && left.blink === right.blink
    && left.bold === right.bold
    && left.concealed === right.concealed
    && left.dim === right.dim
    && left.doubleUnderline === right.doubleUnderline
    && left.encircled === right.encircled
    && left.framed === right.framed
    && left.foregroundColor === right.foregroundColor
    && left.inverse === right.inverse
    && left.italic === right.italic
    && left.overline === right.overline
    && left.strike === right.strike
    && left.subscript === right.subscript
    && left.superscript === right.superscript
    && left.underline === right.underline
    && left.underlineColor === right.underlineColor;
}

function pushAnsiText(spans: AnsiOutputSpan[], text: string, state: AnsiRenderState) {
  if (!text) {
    return;
  }

  const previous = spans.at(-1);
  if (previous && areAnsiStatesEqual(previous.state, state)) {
    previous.text += text;
    return;
  }

  spans.push({
    state: cloneAnsiState(state),
    text,
  });
}

function readControlSequenceEnd(input: string, startIndex: number) {
  for (let index = startIndex; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) {
      return index;
    }
  }

  return input.length - 1;
}

function readOscEnd(input: string, startIndex: number) {
  for (let index = startIndex; index < input.length; index += 1) {
    const character = input[index];
    if (character === "\u0007" || character === STRING_TERMINATOR_8_BIT) {
      return index;
    }

    if (character === ESCAPE && input[index + 1] === "\\") {
      return index + 1;
    }
  }

  return input.length - 1;
}

function parseSgrParameters(sequence: string) {
  const rawParameters = sequence.slice(0, -1);
  if (!rawParameters.length) {
    return [0];
  }

  return rawParameters
    .replace(/:/g, ";")
    .split(";")
    .map((part) => {
      if (!part) {
        return 0;
      }

      const value = Number(part);
      return Number.isFinite(value) ? value : 0;
    });
}

function getAnsiPaletteColor(index: number) {
  if (index >= 0 && index <= 7) {
    return ANSI_STANDARD_COLORS[index];
  }

  if (index >= 8 && index <= 15) {
    return ANSI_BRIGHT_COLORS[index - 8];
  }

  if (index >= 16 && index <= 231) {
    const colorIndex = index - 16;
    const red = Math.floor(colorIndex / 36);
    const green = Math.floor((colorIndex % 36) / 6);
    const blue = colorIndex % 6;
    return `rgb(${red ? red * 40 + 55 : 0}, ${green ? green * 40 + 55 : 0}, ${blue ? blue * 40 + 55 : 0})`;
  }

  if (index >= 232 && index <= 255) {
    const gray = (index - 232) * 10 + 8;
    return `rgb(${gray}, ${gray}, ${gray})`;
  }

  return null;
}

function readExtendedAnsiColor(parameters: number[], startIndex: number) {
  const mode = parameters[startIndex + 1];
  if (mode === 5) {
    return {
      color: getAnsiPaletteColor(parameters[startIndex + 2] ?? -1),
      nextIndex: startIndex + 2,
    };
  }

  if (mode === 2) {
    const red = parameters[startIndex + 2];
    const green = parameters[startIndex + 3];
    const blue = parameters[startIndex + 4];
    if (
      red !== undefined
      && green !== undefined
      && blue !== undefined
      && [red, green, blue].every((value) => value >= 0 && value <= 255)
    ) {
      return {
        color: `rgb(${red}, ${green}, ${blue})`,
        nextIndex: startIndex + 4,
      };
    }

    return {
      color: null,
      nextIndex: startIndex + 4,
    };
  }

  return {
    color: null,
    nextIndex: startIndex,
  };
}

function applyAnsiSgr(parameters: number[], state: AnsiRenderState) {
  for (let index = 0; index < parameters.length; index += 1) {
    const parameter = parameters[index] ?? 0;

    if (parameter === 0) {
      Object.assign(state, DEFAULT_STATE);
    } else if (parameter === 1) {
      state.bold = true;
      state.dim = false;
    } else if (parameter === 2) {
      state.dim = true;
      state.bold = false;
    } else if (parameter === 3) {
      state.italic = true;
    } else if (parameter === 4) {
      state.underline = true;
    } else if (parameter === 21) {
      state.doubleUnderline = true;
      state.underline = true;
    } else if (parameter === 5 || parameter === 6) {
      state.blink = true;
    } else if (parameter === 7) {
      state.inverse = true;
    } else if (parameter === 8) {
      state.concealed = true;
    } else if (parameter === 9) {
      state.strike = true;
    } else if (parameter === 22) {
      state.bold = false;
      state.dim = false;
    } else if (parameter === 23) {
      state.italic = false;
    } else if (parameter === 24) {
      state.doubleUnderline = false;
      state.underline = false;
    } else if (parameter === 25) {
      state.blink = false;
    } else if (parameter === 27) {
      state.inverse = false;
    } else if (parameter === 28) {
      state.concealed = false;
    } else if (parameter === 29) {
      state.strike = false;
    } else if (parameter >= 30 && parameter <= 37) {
      state.foregroundColor = ANSI_STANDARD_COLORS[parameter - 30];
    } else if (parameter === 38) {
      const result = readExtendedAnsiColor(parameters, index);
      state.foregroundColor = result.color;
      index = result.nextIndex;
    } else if (parameter === 39) {
      state.foregroundColor = null;
    } else if (parameter >= 40 && parameter <= 47) {
      state.backgroundColor = ANSI_STANDARD_COLORS[parameter - 40];
    } else if (parameter === 48) {
      const result = readExtendedAnsiColor(parameters, index);
      state.backgroundColor = result.color;
      index = result.nextIndex;
    } else if (parameter === 49) {
      state.backgroundColor = null;
    } else if (parameter === 51) {
      state.framed = true;
      state.encircled = false;
    } else if (parameter === 52) {
      state.encircled = true;
      state.framed = false;
    } else if (parameter === 53) {
      state.overline = true;
    } else if (parameter === 54) {
      state.encircled = false;
      state.framed = false;
    } else if (parameter === 55) {
      state.overline = false;
    } else if (parameter === 58) {
      const result = readExtendedAnsiColor(parameters, index);
      state.underlineColor = result.color;
      index = result.nextIndex;
    } else if (parameter === 59) {
      state.underlineColor = null;
    } else if (parameter === 73) {
      state.superscript = true;
      state.subscript = false;
    } else if (parameter === 74) {
      state.subscript = true;
      state.superscript = false;
    } else if (parameter === 75) {
      state.subscript = false;
      state.superscript = false;
    } else if (parameter >= 90 && parameter <= 97) {
      state.foregroundColor = ANSI_BRIGHT_COLORS[parameter - 90];
    } else if (parameter >= 100 && parameter <= 107) {
      state.backgroundColor = ANSI_BRIGHT_COLORS[parameter - 100];
    }
  }
}

function isPlainControlCharacter(character: string) {
  const code = character.charCodeAt(0);
  return code < 0x20 && character !== "\n" && character !== "\r" && character !== "\t";
}

export function parseAnsiOutput(input: string) {
  const spans: AnsiOutputSpan[] = [];
  const state = cloneAnsiState(DEFAULT_STATE);
  let textStartIndex = 0;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character !== ESCAPE && character !== CSI_8_BIT && character !== OSC_8_BIT && !isPlainControlCharacter(character)) {
      continue;
    }

    pushAnsiText(spans, input.slice(textStartIndex, index), state);

    if (character === CSI_8_BIT || (character === ESCAPE && input[index + 1] === "[")) {
      const sequenceStartIndex = character === CSI_8_BIT ? index + 1 : index + 2;
      const sequenceEndIndex = readControlSequenceEnd(input, sequenceStartIndex);
      const sequence = input.slice(sequenceStartIndex, sequenceEndIndex + 1);
      if (sequence.endsWith("m")) {
        applyAnsiSgr(parseSgrParameters(sequence), state);
      }
      index = sequenceEndIndex;
    } else if (character === OSC_8_BIT || (character === ESCAPE && input[index + 1] === "]")) {
      index = readOscEnd(input, character === OSC_8_BIT ? index + 1 : index + 2);
    } else if (character === ESCAPE) {
      index += input[index + 1] ? 1 : 0;
    }

    textStartIndex = index + 1;
  }

  pushAnsiText(spans, input.slice(textStartIndex), state);
  return spans;
}

function getAnsiSpanStyle(state: AnsiRenderState): CSSProperties | undefined {
  const foregroundColor = state.inverse ? state.backgroundColor ?? "var(--bg)" : state.foregroundColor;
  const backgroundColor = state.inverse ? state.foregroundColor ?? "var(--text)" : state.backgroundColor;
  const textDecorations = [
    state.underline ? "underline" : "",
    state.strike ? "line-through" : "",
    state.overline ? "overline" : "",
  ].filter(Boolean);
  const style: CSSProperties = {};

  if (foregroundColor) {
    style.color = foregroundColor;
  }

  if (backgroundColor) {
    style.backgroundColor = backgroundColor;
  }

  if (state.bold) {
    style.fontWeight = 700;
  }

  if (state.dim) {
    style.opacity = 0.68;
  }

  if (state.italic) {
    style.fontStyle = "italic";
  }

  if (textDecorations.length) {
    style.textDecorationLine = textDecorations.join(" ");
  }

  if (state.doubleUnderline) {
    style.textDecorationStyle = "double";
  }

  if (state.underlineColor) {
    style.textDecorationColor = state.underlineColor;
  }

  if (state.framed || state.encircled) {
    style.border = "1px solid currentColor";
    style.borderRadius = state.encircled ? "999px" : "0.12em";
    style.paddingInline = "0.12em";
  }

  if (state.superscript) {
    style.verticalAlign = "super";
    style.fontSize = "0.78em";
  } else if (state.subscript) {
    style.verticalAlign = "sub";
    style.fontSize = "0.78em";
  }

  if (state.concealed) {
    style.visibility = "hidden";
  }

  return Object.keys(style).length ? style : undefined;
}

export default function ThreadAnsiOutput ({ output }: { output: string }) {
  const spans = parseAnsiOutput(output);
  return spans.map((span, index) => {
    const style = getAnsiSpanStyle(span.state);
    const className = span.state.blink ? "animate-pulse" : undefined;

    if (!style && !className) {
      return <Fragment key={index}>{span.text}</Fragment>;
    }

    return (
      <span className={className} key={index} style={style}>
        {span.text}
      </span>
    );
  });
}
