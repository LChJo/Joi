import type { CreateResultExport, ResultExportDto } from "../../../shared/result-export.js";
export interface ResultExportPorts {
  find?(input: CreateResultExport): Promise<ResultExportDto | null>;
  read(goalId: string, resultId?: string): Promise<{ title: string; body: string } | null>;
  digest(body: string): Promise<string>;
  create(input: CreateResultExport & { title: string; body: string }): Promise<ResultExportDto>;
  get(exportId: string): Promise<ResultExportDto | null>;
  open(exportId: string, reveal: boolean): Promise<void>;
}
