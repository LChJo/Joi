/* Infrastructure adapter: normalizes Windows clipboard bitmaps for vision APIs. */
import { nativeImage } from "electron";

const BITMAP_MIME_TYPE = "image/bmp";
const PNG_MIME_TYPE = "image/png";

export interface BitmapTranscodeInput {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
}

export interface BitmapTranscodeResult {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
}

/**
 * Clipboard captures arrive as uncompressed BMP (e.g. Codux terminal paste),
 * which neither the Anthropic nor the OpenAI vision APIs accept. Decodes the
 * bitmap through Chromium and re-encodes it as PNG so every downstream
 * consumer (attachment context, staged workbench files) sees a
 * model-compatible image. Returns undefined when the input is not a bitmap or
 * the bytes fail to decode; callers keep the original in that case.
 */
export function transcodeBitmapToPng(input: BitmapTranscodeInput): BitmapTranscodeResult | undefined {
  if (input.mimeType !== BITMAP_MIME_TYPE) return undefined;
  const image = nativeImage.createFromBuffer(Buffer.from(input.bytes));
  if (image.isEmpty()) return undefined;
  return {
    bytes: new Uint8Array(image.toPNG()),
    filename: `${input.filename.replace(/\.bmp$/i, "")}.png`,
    mimeType: PNG_MIME_TYPE,
  };
}
