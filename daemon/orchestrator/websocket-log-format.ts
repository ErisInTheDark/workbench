const ANSI_DIM = "\u001b[2m";
const ANSI_RESET = "\u001b[0m";

export function dimWebSocketDetail(value: string) {
  return `${ANSI_DIM}${value}${ANSI_RESET}`;
}
