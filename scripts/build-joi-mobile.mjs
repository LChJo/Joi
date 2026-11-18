import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(".");
const { version } = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)) {
  throw new Error("Android packaging requires a stable project version in major.minor.patch format.");
}
const apkName = `joi-android-${version}-arm64.apk`;

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code === null ? `signal ${signal}` : `code ${String(code)}`}.`));
    });
  });
}

await run(process.execPath, [path.join(projectRoot, "scripts/i18n.mjs"), "check"], projectRoot);
await run(process.execPath, [path.join(projectRoot, "node_modules/electron/cli.js"), path.join(projectRoot, "scripts/render-app-icon.cjs")], projectRoot);
await run(process.execPath, [path.join(projectRoot, "node_modules/electron/cli.js"), path.join(projectRoot, "scripts/render-mobile-brand.cjs")], projectRoot);
await run(process.execPath, [path.join(projectRoot, "scripts", "build-native-remote.mjs"), "--android"], projectRoot);
const mobileRoot = path.join(projectRoot, "apps", "joi_mobile");
const flutterCommand = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "flutter";
const flutterPrefix = process.platform === "win32" ? ["/d", "/s", "/c", "flutter"] : [];
await run(flutterCommand, [...flutterPrefix, "pub", "get"], mobileRoot);
await run(flutterCommand, [...flutterPrefix, "analyze"], mobileRoot);
await run(flutterCommand, [...flutterPrefix, "test"], mobileRoot);
await run(flutterCommand, [...flutterPrefix, "build", "apk", "--release", "--target-platform", "android-arm64", "--build-name", version], mobileRoot);
const releaseDirectory = path.join(projectRoot, "release-joi-mobile");
await mkdir(releaseDirectory, { recursive: true });
await copyFile(
  path.join(mobileRoot, "build", "app", "outputs", "flutter-apk", "app-release.apk"),
  path.join(releaseDirectory, apkName),
);
process.stdout.write(`Joi Android APK copied to release-joi-mobile/${apkName}.\n`);
