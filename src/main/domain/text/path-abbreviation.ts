/**
 * Prints an absolute path as its root plus its last few segments, e.g.
 * `C:\work\projects\checkout\src\index.ts` becomes
 * `C:\…\checkout\src\index.ts`.
 *
 * Examples here deliberately name no real install directory. `tsc` keeps comments in its output,
 * and the packaging check rejects any bundled text containing this project's own name after a path
 * separator — an illustrative example is indistinguishable from a leaked build path.
 *
 * joi used to replace absolute paths with an opaque `[redacted-path]` marker. For a local,
 * single-user desktop app that hid more than it protected: the user's own working paths are
 * not a secret, they are the context that makes a tool trace legible. Credentials stay
 * masked everywhere; a path now survives with its tail visible.
 *
 * A path that needs no abbreviation is returned untouched, which is also the common case:
 * `C:\work\prd.md` is already as short as it can usefully be.
 */
export const PATH_ELISION_MARKER = "…";
export const PATH_DISPLAY_SEGMENTS = 3;

const UNC_ROOT = /^\\\\[^\\/]+[\\/][^\\/]+/u;
const DRIVE_ROOT = /^[A-Za-z]:[\\/]/u;

function isSeparator(char: string | undefined): boolean {
  return char === "\\" || char === "/";
}

/** The root prefix that is always kept, and the separator the path itself uses. */
function rootOf(path: string): { root: string; separator: string } | undefined {
  const unc = UNC_ROOT.exec(path);
  // `\\server\share` is two segments but plays the role of the root, so it is never
  // counted against the visible tail — otherwise a UNC path would show one segment less
  // than an equivalent drive path.
  if (unc !== null) return { root: unc[0], separator: separatorOf(unc[0]) };
  const drive = DRIVE_ROOT.exec(path);
  if (drive !== null) return { root: drive[0], separator: separatorOf(drive[0]) };
  if (path.startsWith("/")) return { root: "/", separator: "/" };
  return undefined;
}

function separatorOf(root: string): string {
  for (let index = root.length - 1; index >= 0; index -= 1) {
    const char = root[index];
    if (isSeparator(char) && char !== undefined) return char;
  }
  return "/";
}

/** Offset of the segment `skip` segments into `text`, skipping its leading separators. */
function segmentStart(text: string, skip: number): number {
  let index = 0;
  for (let seen = 0; seen < skip; seen += 1) {
    while (isSeparator(text[index])) index += 1;
    while (index < text.length && !isSeparator(text[index])) index += 1;
  }
  while (isSeparator(text[index])) index += 1;
  return index;
}

function abbreviate(value: string, keep: number): string {
  const resolved = rootOf(value);
  if (resolved === undefined) return value;
  // Idempotency guard. The abbreviated form still looks like an absolute path, so a second
  // pass would elide the marker as if it were a directory name and drop one more segment —
  // and sanitizers are genuinely re-applied to already-sanitized text (remote projections,
  // workbench context assembled from summaries that were sanitized at write time). Testing
  // for a segment that *equals* the marker is not enough: a path cut mid-name by a length
  // budget (`/a/b/c/d/e…`) carries the marker inside a segment and would drift twice.
  if (value.includes(PATH_ELISION_MARKER)) return value;
  const rest = value.slice(resolved.root.length);
  const segments = rest.split(/[\\/]+/u).filter((segment) => segment !== "");
  if (segments.length <= keep) return value;
  const cut = segmentStart(rest, segments.length - keep);
  const head = resolved.root.replace(/[\\/]+$/u, "");
  // Slicing the original text rather than re-joining segments keeps the path's own
  // separator style and any trailing punctuation byte-for-byte.
  return `${head}${resolved.separator}${PATH_ELISION_MARKER}${resolved.separator}${rest.slice(cut)}`;
}

export function abbreviatePath(path: string, keep = PATH_DISPLAY_SEGMENTS): string {
  return abbreviate(path, keep);
}

/**
 * Abbreviates every path a call site's own pattern finds. The pattern stays owned by the
 * caller — the three sanitizers match deliberately different shapes — but the replacement
 * callback is shared so the whitespace handling below cannot be forgotten in one of them.
 *
 * `work-result.ts` and `workbench-context-assembler.ts` both anchor their pattern with
 * `(?:^|\s)`, so the match carries a leading space. Replacing a match in place has to put
 * that space back, or `at /tmp/a/b/c/d` silently becomes `at/…/b/c/d`.
 */
export function abbreviateAbsolutePaths(text: string, pattern: RegExp, keep = PATH_DISPLAY_SEGMENTS): string {
  return text.replace(pattern, (match) => {
    const leading = /^\s+/u.exec(match)?.[0] ?? "";
    return `${leading}${abbreviate(match.slice(leading.length), keep)}`;
  });
}
