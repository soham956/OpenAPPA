// Identity audience source for `@rcpt:addr/<email>`: the collection `addr/<email>` has exactly
// one member, the address itself. It lets `send` require `contains = ["@rcpt:addr/$to"]` with
// `to` an array, so every recipient must already be a reader. No lookups, no network, no state.
import { readFileSync } from "node:fs";

const TEMPLATES = ["addr/<email>"];
const req = JSON.parse(readFileSync(0, "utf8"));
const fail = (why) => { process.stderr.write(`rcpt-audience: ${why}\n`); process.exit(1); };
if (req.version !== 1 || req.kind !== "audience") fail("not a version 1 audience request");
if (JSON.stringify(req.declaration?.templates) !== JSON.stringify(TEMPLATES)) fail(`templates must be ${TEMPLATES}`);
const art = req.artifact ?? {};
let answer;
if (typeof art.selector === "string") {
  const m = /^addr\/([^\s/@]+@[^\s/@]+\.[^\s/@]+)$/.exec(art.selector);
  if (!m) fail(`unknown selector ${art.selector}`);
  answer = { members: [m[1]] };
} else if (typeof art.member === "string") {
  answer = { principal: null };
} else fail("artifact names no selector or member");
process.stdout.write(JSON.stringify({ version: 1, answer }) + "\n");
