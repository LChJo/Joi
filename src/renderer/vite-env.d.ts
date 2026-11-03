/// <reference types="vite/client" />

import type { DigitalLifeDesktopBridge } from "../shared/product";

declare global {
  interface Window {
    digitalLifeDesktop?: DigitalLifeDesktopBridge;
  }
}

export {};
