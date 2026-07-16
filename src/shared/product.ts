export const ADMIN_PASSWORD_MIN_LENGTH = 6;
export const PRODUCT_NAME = "joi";
export const RUNTIME_EXTENSION_URI = "urn:aimana:digital-life-runtime:v1";

export interface DesktopRuntimeInfo {
  apiOrigin: string;
  platform: string;
  productName: typeof PRODUCT_NAME;
  version: string;
}

export interface DesktopBootstrapNonce {
  expiresAt: string;
  nonce: string;
}

export interface DigitalLifeDesktopBridge {
  createBootstrapNonce(): Promise<DesktopBootstrapNonce>;
  getRuntimeInfo(): Promise<DesktopRuntimeInfo>;
}
