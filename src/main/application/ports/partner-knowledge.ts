export interface PartnerKnowledgeDocMeta {
  bytes: number;
  createdAt: string;
  docId: string;
  filename: string;
  sha256: string;
}

export interface PartnerKnowledgeStore {
  copyTo(srcPartnerId: string, dstPartnerId: string, nextDocId: () => string, createdAt: string): Promise<number>;
  count(partnerId: string): Promise<number>;
  listMeta(partnerId: string): Promise<PartnerKnowledgeDocMeta[]>;
  readBodies(partnerId: string): Promise<{ body: string; filename: string }[]>;
  remove(partnerId: string, docId: string): Promise<boolean>;
  save(input: { body: string; bytes: number; createdAt: string; docId: string; filename: string; partnerId: string }): Promise<string>;
}
