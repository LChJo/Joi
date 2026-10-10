const { app, BrowserWindow, nativeImage } = require("electron");
const { Buffer } = require("node:buffer");
const { mkdtempSync } = require("node:fs");
const { copyFile, readFile, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const process = require("node:process");
const { setTimeout: delay } = require("node:timers/promises");

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.setPath("userData", mkdtempSync(path.join(os.tmpdir(), "joi-mobile-brand-")));

app.whenReady().then(async () => {
  const mobileRoot = path.resolve("apps/joi_mobile");
  const resources = path.join(mobileRoot, "android/app/src/main/res");
  const icon = nativeImage.createFromPath(path.resolve("resources/branding/icon.png"));
  if (icon.isEmpty()) throw new Error("The desktop Joi icon is missing.");

  for (const [density, scale] of [["mdpi", 1], ["hdpi", 1.5], ["xhdpi", 2], ["xxhdpi", 3], ["xxxhdpi", 4]]) {
    const size = 48 * scale;
    const resizedIcon = icon.resize({ height: size, quality: "best", width: size });
    // Bitmap encoding preserves the displayed colors when Android strips PNG color profiles.
    const launcher = nativeImage.createFromBitmap(resizedIcon.toBitmap(), { height: size, width: size });
    await writeFile(path.join(resources, `mipmap-${density}/ic_launcher.png`), launcher.toPNG());
    // The 72dp portrait sits inside a 108dp layer so Android's launcher masks preserve the face.
    const layerSize = 108 * scale;
    const portraitSize = 72 * scale;
    const offset = 18 * scale;
    const portrait = icon.resize({ height: portraitSize, quality: "best", width: portraitSize }).toBitmap();
    const layer = Buffer.alloc(layerSize * layerSize * 4);
    for (let row = 0; row < portraitSize; row += 1) {
      portrait.copy(layer, ((row + offset) * layerSize + offset) * 4, row * portraitSize * 4, (row + 1) * portraitSize * 4);
    }
    const foreground = nativeImage.createFromBitmap(layer, { height: layerSize, width: layerSize });
    await writeFile(path.join(resources, `mipmap-${density}/ic_launcher_foreground.png`), foreground.toPNG());
  }
  await copyFile(path.resolve("src/renderer/joi-avatar.png"), path.join(mobileRoot, "assets/joi-portrait.png"));

  const wordmarkSvg = await readFile(path.resolve("src/renderer/joi-wordmark.svg"), "utf8");
  const window = new BrowserWindow({
    backgroundColor: "#00000000", focusable: false, frame: false,
    height: 144, show: true, skipTaskbar: true, transparent: true, width: 228,
    webPreferences: { backgroundThrottling: false, sandbox: true },
    x: -10_000, y: -10_000,
  });
  try {
    await window.loadURL(`data:image/svg+xml;base64,${Buffer.from(wordmarkSvg).toString("base64")}`);
    await delay(300);
    const wordmark = await window.webContents.capturePage({ height: 144, width: 228, x: 0, y: 0 });
    const bitmap = wordmark.toBitmap();
    if (bitmap[3] !== 0 || !bitmap.some((value, index) => index % 4 === 3 && value > 0)) {
      throw new Error("The mobile Joi wordmark must contain transparent space and visible strokes.");
    }
    await writeFile(path.join(mobileRoot, "assets/joi-wordmark.png"), wordmark.toPNG({ scaleFactor: 1 }));
  } finally {
    window.destroy();
  }
  process.stdout.write("Joi mobile portrait, wordmark and five launcher densities match the desktop brand.\n");
  app.quit();
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  app.exit(1);
});
