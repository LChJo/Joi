import "./styles.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { RemoteJoiApp } from "./RemoteJoiApp";
import { BrowserRemoteJoiConnection } from "./remote-connection";
import { configureLocale } from "./i18n";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("Renderer root element is missing.");
}

if (window.digitalLifeDesktop !== undefined) {
  const info = await window.digitalLifeDesktop.getRuntimeInfo().catch(() => undefined);
  if (info !== undefined) configureLocale({ preference: info.uiLocale, systemLanguages: info.systemLanguages ?? navigator.languages });
}

const application = window.location.pathname.startsWith("/remote")
  ? <RemoteJoiApp connection={new BrowserRemoteJoiConnection()} />
  : <App />;

createRoot(rootElement).render(
  <StrictMode>
    {application}
  </StrictMode>,
);
