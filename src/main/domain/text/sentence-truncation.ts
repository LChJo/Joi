const CJK_TERMINATORS = new Set(["。", "！", "？", "；", "\n"]);
const ASCII_TERMINATORS = new Set([".", "!", "?", ";"]);

function isSentenceBoundary(text: string, index: number): boolean {
  const char = text[index];
  if (char === undefined) return false;
  if (CJK_TERMINATORS.has(char)) return true;
  if (ASCII_TERMINATORS.has(char)) {
    const next = text[index + 1];
    return next === undefined || /\s/u.test(next);
  }
  return false;
}

/**
 * Truncate a preview at a sentence boundary instead of a raw character cut. A fixed
 * cut lands mid-sentence (often mid-word), leaving a fragment that reads as
 * corruption; when a boundary fits inside `limit` the preview ends after the last
 * complete sentence. The cut never extends past `limit`: callers rely on the limit
 * as a hard bound (safe context snapshots treat the preview as bounded data), so
 * text without any boundary inside the limit falls back to the plain character cut.
 */
export function truncateAtSentenceBoundary(text: string, limit: number): string {
  if (text.length <= limit) return text;
  for (let index = limit - 1; index >= 0; index -= 1) {
    if (isSentenceBoundary(text, index)) return text.slice(0, index + 1).trimEnd();
  }
  return text.slice(0, limit).trimEnd();
}
