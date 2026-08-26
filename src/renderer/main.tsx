import "./styles.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { RemoteJoiApp } from "./RemoteJoiApp";
import { BrowserRemoteJoiConnection } from "./remote-connection";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("Renderer root element is missing.");
}

const application = window.location.pathname.startsWith("/remote")
  ? <RemoteJoiApp connection={new BrowserRemoteJoiConnection()} />
  : <App />;

createRoot(rootElement).render(
  <StrictMode>
    {application}
  </StrictMode>,
);
