import type { CreateResultExport } from "../../../shared/result-export.js";
import type { ResultExportPorts } from "../ports/result-export.js";
import { DomainError } from "../../domain/errors.js";
export class ResultExportService {
  constructor(private readonly ports: ResultExportPorts) {}
  async create(input: CreateResultExport) {
    if (!["pdf", "png"].includes(input.format) || !/^[\w-]{1,100}$/.test(input.idempotencyKey)) throw new DomainError("export_invalid", "export_invalid");
    const existing = await this.ports.find?.(input);
    if (existing) return existing;
    const snapshot = await this.ports.read(input.goalId, input.resultId);
    if (!snapshot?.body.trim()) throw new DomainError("export_empty", "export_empty");
    if (await this.ports.digest(snapshot.body) !== input.digest) throw new DomainError("export_snapshot_changed", "export_snapshot_changed");
    return this.ports.create({ ...input, ...snapshot });
  }
  get(exportId: string) { return this.ports.get(exportId); }
  open(exportId: string, reveal: boolean) { return this.ports.open(exportId, reveal); }
}
