import { access, copyFile, mkdir, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const projectRoot = path.resolve(".");
const crateRoot = path.join(projectRoot, "native", "joi-remote");
const android = process.argv.includes("--android");

async function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { await access(candidate); return candidate; } catch { /* Try the next candidate. */ }
  }
  return undefined;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: crateRoot, env: process.env, stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code === null ? `signal ${signal}` : `code ${String(code)}`}.`));
    });
  });
}

const cargoName = process.platform === "win32" ? "cargo.exe" : "cargo";
const cargo = await firstExisting([
  process.env.CARGO,
  path.join(os.homedir(), ".cargo", "bin", cargoName),
]);
if (cargo === undefined) throw new Error("Rust Cargo is required to build Joi native remote support.");

if (!android) {
  await run(cargo, ["build", "--release", "--bin", "joi-remote-sidecar"]);
  const executable = `joi-remote-sidecar${process.platform === "win32" ? ".exe" : ""}`;
  const destinationDirectory = path.join(projectRoot, "resources", "native", process.platform);
  await mkdir(destinationDirectory, { recursive: true });
  await copyFile(path.join(crateRoot, "target", "release", executable), path.join(destinationDirectory, executable));
  process.stdout.write(`Built Joi desktop native transport for ${process.platform}.\n`);
  process.exit(0);
}

if (process.platform !== "win32" && process.platform !== "darwin" && process.platform !== "linux") {
  throw new Error("Android native builds require a supported desktop host.");
}
let ndkHome = process.env.ANDROID_NDK_HOME;
if (!ndkHome) {
  const sdkRoot = process.env.ANDROID_HOME
    ?? (process.platform === "win32" ? path.join(process.env.LOCALAPPDATA ?? "", "Android", "sdk") : undefined);
  if (sdkRoot) {
    const ndkRoot = path.join(sdkRoot, "ndk");
    const versions = await readdir(ndkRoot).catch(() => []);
    const latest = versions.sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))[0];
    if (latest) ndkHome = path.join(ndkRoot, latest);
  }
}
if (!ndkHome) throw new Error("Android NDK was not found. Set ANDROID_NDK_HOME.");

const temporaryOutput = path.join(projectRoot, "tmp", "joi-native-android");
const relativeTemporary = path.relative(projectRoot, temporaryOutput);
if (relativeTemporary.startsWith("..") || path.isAbsolute(relativeTemporary)) throw new Error("Invalid native output path.");
await rm(temporaryOutput, { force: true, recursive: true });
await mkdir(temporaryOutput, { recursive: true });
await run(cargo, ["ndk", "-t", "arm64-v8a", "-o", temporaryOutput, "build", "--release", "--lib"], {
  env: { ...process.env, ANDROID_NDK_HOME: ndkHome },
});
const destinationDirectory = path.join(projectRoot, "apps", "joi_mobile", "android", "app", "src", "main", "jniLibs", "arm64-v8a");
const relativeDestination = path.relative(projectRoot, destinationDirectory);
if (relativeDestination.startsWith("..") || path.isAbsolute(relativeDestination)) throw new Error("Invalid Android JNI output path.");
await rm(destinationDirectory, { force: true, recursive: true });
await mkdir(destinationDirectory, { recursive: true });
await copyFile(
  path.join(temporaryOutput, "arm64-v8a", "libjoi_remote.so"),
  path.join(destinationDirectory, "libjoi_remote.so"),
);
await rm(temporaryOutput, { force: true, recursive: true });
process.stdout.write("Built Joi Android native transport for arm64-v8a.\n");
