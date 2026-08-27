/* global process */

import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "start") {
    process.stdout.write(`${JSON.stringify({
      ticket: {
        directAddresses: ["192.0.2.20:49152"],
        endpointId: "fixture-endpoint",
        relayUrls: ["https://relay.example.com/"],
        version: 1,
      },
      type: "ready",
    })}\n`);
  } else if (command.type === "send") {
    process.stdout.write(`${JSON.stringify({ connectionId: command.connectionId, type: "peerOpen" })}\n`);
    process.stdout.write(`${JSON.stringify({ connectionId: command.connectionId, frame: command.frame, type: "peerFrame" })}\n`);
  } else if (command.type === "close") {
    process.stdout.write(`${JSON.stringify({ connectionId: command.connectionId, type: "peerClose" })}\n`);
  } else if (command.type === "shutdown") {
    process.exit(0);
  }
});
