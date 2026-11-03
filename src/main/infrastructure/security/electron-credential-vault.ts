import { safeStorage } from "electron";

import type { CredentialVault } from "../../application/ports/a2a-ports.js";

export class ElectronCredentialVault implements CredentialVault {
  decrypt(ciphertext: Uint8Array): Promise<string> {
    return Promise.resolve(safeStorage.decryptString(Buffer.from(ciphertext)));
  }

  encrypt(token: string): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array(safeStorage.encryptString(token)));
  }

  isAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  }
}
