const { app, BrowserWindow } = require("electron");
const { Buffer } = require("node:buffer");
const { createHash } = require("node:crypto");
const { mkdtempSync } = require("node:fs");
const { mkdir, readFile, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const process = require("node:process");
const { setTimeout: delay } = require("node:timers/promises");

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.setPath("userData", mkdtempSync(path.join(os.tmpdir(), "joi-icon-render-")));

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function isValidIcon(png) {
  return png.byteLength >= 4_096
    && png.subarray(0, 8).equals(PNG_SIGNATURE)
    && png.readUInt32BE(16) === 1024
    && png.readUInt32BE(20) === 1024;
}

async function writeIconCopies(directory, png) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "icon.png"), png);
  const publicDirectory = path.resolve("public");
  await mkdir(publicDirectory, { recursive: true });
  await writeFile(path.join(publicDirectory, "icon.png"), png);
}

async function captureIcon(window) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await delay(attempt * 150);
    try {
      const image = await window.webContents.capturePage({ height: 1024, width: 1024, x: 0, y: 0 });
      const png = image.toPNG({ scaleFactor: 1 });
      if (isValidIcon(png)) return png;
      lastError = new Error(`The rendered joi icon is invalid (${String(png.readUInt32BE(16))}x${String(png.readUInt32BE(20))}, ${String(png.byteLength)} bytes).`);
    } catch (error) {
      lastError = error;
    }
    window.webContents.invalidate();
  }
  throw lastError instanceof Error ? lastError : new Error("The joi icon could not be rendered.");
}

app.whenReady().then(async () => {
  const directory = path.resolve("resources/branding");
  const sourceHashPath = path.resolve("scripts/render-app-icon.sha256");
  const svgBuffer = await readFile(path.join(directory, "icon.svg"));
  const sourceHash = createHash("sha256").update(svgBuffer).digest("hex");
  const [cachedHash, cachedPng] = await Promise.all([
    readFile(sourceHashPath, "utf8").catch(() => ""),
    readFile(path.join(directory, "icon.png")).catch(() => undefined),
  ]);
  const [cachedSourceHash, cachedPngHash] = cachedHash.trim().split(/\s+/u);
  const actualPngHash = cachedPng === undefined ? "" : createHash("sha256").update(cachedPng).digest("hex");
  if (cachedSourceHash === sourceHash && cachedPngHash === actualPngHash && cachedPng !== undefined && isValidIcon(cachedPng)) {
    await writeIconCopies(directory, cachedPng);
    process.stdout.write("The cached 1024x1024 joi icon matches resources/branding/icon.svg.\n");
    app.quit();
    return;
  }

  const window = new BrowserWindow({
    backgroundColor: "#00000000",
    focusable: false,
    frame: false,
    height: 1024,
    show: true,
    skipTaskbar: true,
    transparent: true,
    webPreferences: { backgroundThrottling: false, sandbox: true },
    width: 1024,
    x: -10_000,
    y: -10_000,
  });
  try {
    await window.loadFile(path.join(directory, "icon.svg"));
    const png = await captureIcon(window);
    await writeIconCopies(directory, png);
    await writeFile(sourceHashPath, `${sourceHash} ${createHash("sha256").update(png).digest("hex")}\n`, "utf8");
    process.stdout.write("Rendered 1024x1024 joi icons from resources/branding/icon.svg.\n");
  } finally {
    window.destroy();
  }
  app.quit();
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  app.exit(1);
});
