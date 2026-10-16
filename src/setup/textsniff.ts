// Is a file TEXT a lens can read, or a binary it cannot? One answer for every
// reader of the reviewed checkout (the scan's materialised trees and the
// setup engine's checkout reader), so the two never disagree about a file.
//
// git's bare test — any NUL in the first 8000 bytes is binary — would drop a
// source file with ONE stray NUL (a literal NUL in a template literal) out of
// every lens's coverage. The sniff below keeps git's NUL probe as the trigger
// but needs corroboration before it calls a file binary: a known-binary
// extension, a high share of control bytes, or a
// sample that is not UTF-8 at all. Compressed or encoded bytes (images,
// archives, fonts, object code) fail those overwhelmingly; a text file with a
// stray control byte passes them.
//
// A file judged binary is never silently absent: the caller reports it as
// `skipped: binary` (see `ScanTree.whyUnreadable`).

/** git's own probe window. */
export const SNIFF_BYTES = 8000;
/** Share of control bytes in the window above which a NUL-bearing file is
 * binary. Uniformly random bytes carry ~11%; source text carries ~0. */
const CONTROL_SHARE = 0.05;

/** Extensions that corroborate a NUL: a NUL-bearing file under one of these
 * names is binary without further evidence. Consulted ONLY once the NUL probe
 * fires, so a NUL-free file stays text whatever its name — exactly git's
 * answer (a text `.bin` fixture or a Wavefront `.obj` is never silently
 * dropped). */
const BINARY_EXT_RE =
  /\.(png|jpe?g|gif|bmp|ico|webp|avif|tiff?|pdf|zip|gz|tgz|bz2|xz|zst|7z|rar|jar|war|whl|egg|so|dylib|dll|exe|o|a|lib|class|pyc|pyo|wasm|woff2?|ttf|otf|eot|mp3|mp4|m4a|wav|ogg|flac|webm|mov|avi|sqlite3?|db|bin)$/i;

export function isBinaryPath(path: string): boolean {
  return BINARY_EXT_RE.test(path);
}

/** A control byte that no text carries: C0 minus tab, LF, VT, FF, CR, and
 * ESC (terminal colour codes in logs and fixtures); plus DEL. */
function isControl(b: number): boolean {
  return (
    (b < 0x20 &&
      b !== 0x09 &&
      b !== 0x0a &&
      b !== 0x0b &&
      b !== 0x0c &&
      b !== 0x0d &&
      b !== 0x1b) ||
    b === 0x7f
  );
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Is the window valid UTF-8? A window cut mid-file may end inside one
 * multi-byte sequence, so up to three trailing bytes are forgiven. */
function isUtf8(window: Buffer, truncated: boolean): boolean {
  for (let cut = 0; cut <= (truncated ? 3 : 0); cut++) {
    try {
      utf8.decode(window.subarray(0, window.length - cut));
      return true;
    } catch {
      /* try one byte shorter */
    }
  }
  return false;
}

/** Binary? No NUL in git's window is text, as git says. A NUL is binary only
 * when corroborated: a known-binary extension of `path` (repo-relative), a
 * high share of control bytes, or a window that is not UTF-8. */
export function isBinaryContent(buf: Buffer, path = ""): boolean {
  const window = buf.subarray(0, SNIFF_BYTES);
  if (!window.includes(0)) return false;
  if (path !== "" && isBinaryPath(path)) return true;
  let control = 0;
  for (const b of window) if (isControl(b)) control++;
  if (control > 1 && control / window.length > CONTROL_SHARE) return true;
  return !isUtf8(window, buf.length > window.length);
}

/** Text for a prompt, a ledger note or a terminal: every control character a
 * lens or a screen must never receive raw (NUL above all) rendered as a
 * visible `\u00XX` escape. Tab and newline are kept. */
export function escapeControls(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(
    /[\u0000-\u0008\u000b-\u001f\u007f]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Source line bounds: an empty file has none; a terminal newline adds no line. */
export function textLineCount(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) count++;
  return text !== "" && !text.endsWith("\n") ? count + 1 : count;
}
