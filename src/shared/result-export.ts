export type ResultExportFormat = "pdf" | "png";
export interface CreateResultExport {
  goalId: string;
  format: ResultExportFormat;
  digest: string;
  idempotencyKey: string;
}
export interface ResultExportDto {
  exportId: string;
  status: "queued" | "rendering" | "completed" | "failed";
  filenames: string[];
  count: number;
  errorCode?: string;
}
export function exportBasename(title: string, time: string, suffix: string): string {
  const safe = title.replace(/[\p{Cc}<>:"/\\|?*]/gu, "_").replace(/^[. ]+|[. ]+$/g, "").slice(0, 60) || "Joi";
  return `${safe}-${time.replace(/[^0-9]/g, "").slice(0, 14)}-${suffix.replace(/[^a-z0-9]/gi, "").slice(0, 12)}`;
}
export function exportSlices(height: number, boundaries: number[]): { y: number; height: number }[] {
  const result: { y: number; height: number }[] = [];
  for (let y = 0; y < height;) {
    const limit = Math.min(height, y + 8192);
    const boundary = limit === height ? limit : boundaries.reduce((end, b) => b > end && b <= limit ? b : end, y);
    const end = boundary > y ? boundary : limit;
    result.push({ y, height: end - y });
    y = end;
  }
  return result;
}
