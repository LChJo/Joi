export interface LanguageRegistration { code: string; name: string; enabled: boolean }
export interface MessageDefinition { message: string; description?: string; sourceText?: string; errorCode?: string; placeholders?: Record<string, "string" | "number"> }
export interface CatalogData {
  manifest: { source: string; languages: LanguageRegistration[] };
  definitions: Record<string, MessageDefinition>;
  catalogs: Record<string, Record<string, string>>;
}
export interface CatalogStatistics {
  locale: string; enabled: boolean; total: number; translated: number; coverage: number;
  missing: string[]; empty: string[]; extra: string[]; invalid: string[];
  namespaces: Record<string, { total: number; translated: number }>;
}
export function loadCatalogs(base?: string): Promise<CatalogData>;
export function catalogStats(data: CatalogData): CatalogStatistics[];
export function generatedFiles(data: CatalogData): Map<string, string>;
export function runMaintenance(args: string[], projectRoot?: string): Promise<void>;
