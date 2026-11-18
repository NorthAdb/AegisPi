// Minimal readline U+2028/U+2029 reproduction. Run under different Node
// versions to document where the hazard exists. Not part of test:contracts.

import readline from "node:readline";
import { PassThrough } from "node:stream";

const U2028 = "\u2028";
const U2029 = "\u2029";
const payload = JSON.stringify({ message: `A${U2028}B${U2029}C` });
const input = Buffer.concat([Buffer.from(payload, "utf8"), Buffer.from("\n")]);

const pt = new PassThrough();
const lines = [];
let bad = 0;
const rl = readline.createInterface({ input: pt });
rl.on("line", (l) => {
  lines.push(l);
  try {
    JSON.parse(l);
  } catch {
    bad++;
  }
});
await new Promise((resolve) => {
  rl.on("close", resolve);
  pt.end(input);
});

console.log(
  JSON.stringify({
    node: process.version,
    inputBytes: input.length,
    readlineLines: lines.length,
    readlineParseFailures: bad,
  }),
);
