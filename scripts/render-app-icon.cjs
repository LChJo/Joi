const { app, BrowserWindow } = require("electron");
const { Buffer } = require("node:buffer");
const { mkdir, readFile, writeFile } = require("node:fs/promises");
const path = require("node:path");
const process = require("node:process");

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const directory = path.resolve("resources/branding");
  const svg = await readFile(path.join(directory, "icon.svg"), "utf8");
  const window = new BrowserWindow({
    backgroundColor: "#0f1f18",
    frame: false,
    height: 1024,
    show: false,
    webPreferences: { sandbox: true },
    width: 1024,
  });
  await window.loadURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
  const icon = await window.webContents.capturePage({ height: 1024, width: 1024, x: 0, y: 0 });
  const png = icon.toPNG();
  if (png.byteLength < 16_384) throw new Error("The rendered joi icon is unexpectedly small.");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "icon.png"), png);
  const publicDirectory = path.resolve("public");
  await mkdir(publicDirectory, { recursive: true });
  await writeFile(path.join(publicDirectory, "icon.png"), png);
  window.destroy();
  app.quit();
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  app.exit(1);
});
