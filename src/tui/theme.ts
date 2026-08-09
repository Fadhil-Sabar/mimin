/**
 * Shared terminal color theme.
 *
 * A single, deliberately small ANSI palette shared by every TUI component so
 * the app has one visual language: dim gray for chrome and secondary text,
 * green for success, yellow for warnings/failures, cyan for emphasis.
 * Theme functions wrap plain text with ANSI SGR codes and never take
 * pre-styled input, so components can safely nest them.
 */

const SGR = {
  reset: "\u001b[0m",
  /** Bright gray; muted chrome, labels, secondary text. */
  dim: "\u001b[2m",
  /** TrueColor green; success and running state. */
  green: "\u001b[38;2;52;211;153m",
  /** TrueColor yellow; warnings, failures, attention. */
  yellow: "\u001b[38;2;229;192;123m",
  /** TrueColor cyan; emphasis, active elements. */
  cyan: "\u001b[38;2;86;182;194m",
} as const;

function wrap(code: string, text: string): string {
  return `${code}${text}${SGR.reset}`;
}

/** Muted secondary text (labels, metadata, box borders). */
export function dim(text: string): string {
  return wrap(SGR.dim, text);
}

/** Green text (success states). */
export function green(text: string): string {
  return wrap(SGR.green, text);
}

/** Yellow text (warnings, failures). */
export function yellow(text: string): string {
  return wrap(SGR.yellow, text);
}

/** Cyan text (emphasis, active elements). */
export function cyan(text: string): string {
  return wrap(SGR.cyan, text);
}
