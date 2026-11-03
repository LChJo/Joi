/**
 * Turns the attachments bound to a joi input into model-visible context.
 * Application layer: no node builtins here (architecture boundaries) — base64
 * uses the same btoa chunking as src/renderer/api.ts and decoding uses the
 * global TextDecoder.
 */

export interface JoiAttachmentSummary {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface JoiAttachmentContext {
  attachmentIds: readonly string[];
  images: readonly { data: string; mimeType: string }[];
  promptAddendum: string;
}

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_INLINE_CHARS_PER_FILE = 48_000;
const MAX_INLINE_CHARS_TOTAL = 96_000;

const IMAGE_MIME_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);
const TEXT_MIME_TYPES = new Set([
  "application/csv",
  "application/javascript",
  "application/json",
  "application/sql",
  "application/toml",
  "application/typescript",
  "application/x-csv",
  "application/x-ndjson",
  "application/x-sh",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
]);
const TEXT_EXTENSIONS = new Set([
  "bash", "c", "cfg", "conf", "cpp", "cs", "css", "csv", "diff", "env", "go", "h", "hpp", "cc",
  "htm", "html", "ini", "java", "js", "json", "jsonl", "jsx", "kt", "log", "mjs", "cjs", "md",
  "markdown", "ndjson", "patch", "php", "py", "r", "rb", "rs", "scala", "sh", "sql", "swift",
  "text", "toml", "ts", "tsx", "tsv", "txt", "xml", "yaml", "yml", "zsh",
]);

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot < 0 ? "" : filename.slice(dot + 1).toLowerCase();
}

function looksTextual(filename: string, mimeType: string): boolean {
  if (mimeType.startsWith("text/")) return true;
  if (TEXT_MIME_TYPES.has(mimeType)) return true;
  return TEXT_EXTENSIONS.has(extensionOf(filename));
}

function decodeStrictUtf8(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function metadataLine(summary: JoiAttachmentSummary): string {
  return `${summary.attachmentId} ${summary.filename} ${summary.mimeType} ${String(summary.size)} bytes`;
}

/**
 * Reads every attachment through the verified reader and assembles what the
 * model actually receives: inline text blocks, image parts, and metadata-only
 * notes for anything that cannot be delivered. Per-file failures degrade to a
 * note line; this function never throws.
 */
export async function buildJoiAttachmentContext(input: {
  attachments: readonly JoiAttachmentSummary[];
  reader: (attachmentId: string) => Promise<{ bytes: Uint8Array; filename: string; mimeType: string }>;
}): Promise<JoiAttachmentContext> {
  const blocks: string[] = [];
  const images: { data: string; mimeType: string }[] = [];
  let imageBytesTotal = 0;
  let inlineCharsTotal = 0;
  for (const summary of input.attachments) {
    if (IMAGE_MIME_TYPES.has(summary.mimeType)) {
      if (summary.size > MAX_IMAGE_BYTES || imageBytesTotal + summary.size > MAX_IMAGE_TOTAL_BYTES) {
        blocks.push(`Image attachment too large to attach (${metadataLine(summary)}); reference it by metadata only.`);
        continue;
      }
      try {
        const attachment = await input.reader(summary.attachmentId);
        images.push({ data: toBase64(attachment.bytes), mimeType: summary.mimeType });
        imageBytesTotal += summary.size;
        blocks.push(`Image attachment "${summary.filename}" (${metadataLine(summary)}) is attached to this message as an image.`);
      } catch {
        blocks.push(`Image attachment could not be read (${metadataLine(summary)}); reference it by metadata only.`);
      }
      continue;
    }
    if (summary.size === 0) {
      blocks.push(`Attachment is empty (${metadataLine(summary)}).`);
      continue;
    }
    if (!looksTextual(summary.filename, summary.mimeType)) {
      blocks.push(`Attachment was not delivered inline (${metadataLine(summary)}). If it is text, read it with attachment_read using attachmentId "${summary.attachmentId}"; otherwise rely on this metadata and never invent its content.`);
      continue;
    }
    let attachment: { bytes: Uint8Array; filename: string; mimeType: string };
    try {
      attachment = await input.reader(summary.attachmentId);
    } catch {
      blocks.push(`Attachment could not be read (${metadataLine(summary)}); reference it by metadata only.`);
      continue;
    }
    const text = decodeStrictUtf8(attachment.bytes);
    if (text === null) {
      blocks.push(`Attachment looks textual by name but is not valid UTF-8 (${metadataLine(summary)}). Use attachment_read with attachmentId "${summary.attachmentId}" only if you expect decodable text; otherwise rely on this metadata.`);
      continue;
    }
    const budget = Math.min(MAX_INLINE_CHARS_PER_FILE, MAX_INLINE_CHARS_TOTAL - inlineCharsTotal);
    if (budget <= 0) {
      blocks.push(`Inline attachment budget is exhausted (${metadataLine(summary)}). Read it with attachment_read using attachmentId "${summary.attachmentId}".`);
      continue;
    }
    const escaped = text.replaceAll("</joi-attachment", "<\\/joi-attachment");
    if (escaped.length <= budget) {
      blocks.push(`<joi-attachment attachmentId="${summary.attachmentId}" name="${summary.filename}" mime="${summary.mimeType}">\n${escaped}\n</joi-attachment>`);
      inlineCharsTotal += escaped.length;
      continue;
    }
    const slice = escaped.slice(0, budget);
    blocks.push(`<joi-attachment attachmentId="${summary.attachmentId}" name="${summary.filename}" mime="${summary.mimeType}">\n${slice}\n[…内容已截断：调用 attachment_read(attachmentId="${summary.attachmentId}", cursor="${String(budget)}") 继续读取后续内容]\n</joi-attachment>`);
    inlineCharsTotal += budget;
  }
  if (blocks.length === 0) return { attachmentIds: [], images: [], promptAddendum: "" };
  const header = `[joi attachments] The user attached ${String(input.attachments.length)} file(s) to this input. Text content is inlined below between <joi-attachment> markers; image files are attached to this message as images; anything else is listed by metadata only. Never invent attachment content that was not delivered.`;
  return {
    attachmentIds: input.attachments.map((summary) => summary.attachmentId),
    images,
    promptAddendum: [header, ...blocks].join("\n\n"),
  };
}
