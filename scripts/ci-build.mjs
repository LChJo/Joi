import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

let output = "";
const child = spawn("npm run build:prod", { shell: true, stdio: ["ignore", "pipe", "pipe"] });

function capture(stream, destination) {
  stream.on("data", (chunk) => {
    destination.write(chunk);
    output = (output + chunk.toString()).slice(-32_768);
  });
}

function reportFailure() {
  if (process.env.GITHUB_ACTIONS !== "true") return;
  const lines = stripVTControlCharacters(output).split(/\r?\n/u)
    .filter((line) => /\b(?:error(?:\[|:|\s)|fatal:|failed to|cannot find|could not compile)/iu.test(line));
  const message = (lines.slice(-10).join("\n") || "Production build failed before Electron E2E started.")
    .replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  process.stdout.write(`::error title=Production build failed::${message}\n`);
}

capture(child.stdout, process.stdout);
capture(child.stderr, process.stderr);
child.on("error", (error) => {
  output += `\nError: ${error.message}`;
});
child.on("close", (code) => {
  if (code !== 0) reportFailure();
  process.exitCode = code === null || code < 0 ? 1 : code;
});
