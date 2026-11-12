import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { Buffer } from "node:buffer";
const root = process.env.AGENT_BROWSER_SOCKET_DIR;
const session = process.env.AGENT_BROWSER_SESSION;
if (!root || !session) process.exit(2);
const socketDirectory = path.resolve(root);
if (process.env.AGENT_BROWSER_DAEMON === "1") {
  if (process.argv.includes("--fixture-state")) fs.writeFileSync(path.join(path.dirname(socketDirectory),"fixture-state.json"),JSON.stringify({ socketDirectory,socketPathBytes: Buffer.byteLength(path.join(root,session + ".sock")) }));
  if (process.argv.includes("--fixture-start-failure")) process.exit(1);
  const server = net.createServer(socket => {
    let request = "";
    socket.on("data", chunk => {
      request += chunk;
      if (!request.includes("\n")) return;
      const args = JSON.parse(request.trim());
      if (args.includes("fixture-hang")) return;
      if (args.at(-1) === "close" && path.basename(path.dirname(socketDirectory)).startsWith("joi-browser-close-")) fs.writeFileSync(path.join(path.dirname(socketDirectory),"closed.json"),"true");
      if (args.includes("fixture-unknown")) { socket.end(JSON.stringify({ success: false,code: "outcome_unknown",error: "synthetic-secret-details" }) + "\n");return; }
      if (args.includes("fixture-large")) { socket.end(JSON.stringify({ success: true,data: "x".repeat(600_000) }) + "\n");return; }
      if (args.includes("fixture-long")) { socket.end(JSON.stringify({ success: true,data: { text: "x".repeat(25_000),authorization: "synthetic-secret-details" } }) + "\n");return; }
      const screenshot = args.indexOf("screenshot");
      if (screenshot !== -1) fs.writeFileSync(args[screenshot + 1],Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=","base64"));
      socket.end(JSON.stringify({ success: true,data: { args,session,privateConfig: fs.existsSync(process.env.AGENT_BROWSER_CONFIG),secretInherited: !!process.env.FIXTURE_PROVIDER_API_KEY,autoConnect: !!process.env.AGENT_BROWSER_AUTO_CONNECT,projectConfigRead: fs.existsSync(path.join(process.cwd(),"agent-browser.json")) } }) + "\n");
    });
  });
  server.listen(process.platform === "win32" ? { port: 0,host: "127.0.0.1" } : { path: path.join(root,session + ".sock") },() => {
    fs.writeFileSync(path.join(root,session + ".pid"),String(process.pid));
    fs.writeFileSync(path.join(root,session + ".version"),"0.42.0");
    if (process.platform === "win32") fs.writeFileSync(path.join(root,session + ".port"),String(server.address().port));
  });
} else {
  const args = process.argv.slice(2);
  const endpoint = process.platform === "win32" ? { port: Number(fs.readFileSync(path.join(root,session + ".port"),"utf8")),host: "127.0.0.1" } : { path: path.join(root,session + ".sock") };
  const socket = net.connect(endpoint,() => socket.write(JSON.stringify(args) + "\n"));
  socket.on("data",chunk => process.stdout.write(chunk));
  socket.on("error",() => process.exit(1));
}
