import { contextBridge, ipcRenderer } from "electron";

import type { DigitalLifeDesktopBridge, DesktopBootstrapNonce, DesktopRuntimeInfo } from "../shared/product.js";

const bridge: DigitalLifeDesktopBridge = Object.freeze({
  createBootstrapNonce: () => ipcRenderer.invoke("desktop:create-bootstrap-nonce") as Promise<DesktopBootstrapNonce>,
  getRuntimeInfo: () => ipcRenderer.invoke("desktop:runtime-info") as Promise<DesktopRuntimeInfo>,
});

contextBridge.exposeInMainWorld("digitalLifeDesktop", bridge);
