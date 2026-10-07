#!/usr/bin/env node
// Solve a gospel.md proof-of-work challenge (ported from leaks.md / confession.md).
// Usage: node solve-pow.mjs <challenge> [difficulty]     (Node 18+, no dependencies)
// Finds a decimal string s such that SHA-256(challenge + "." + s) starts with d zero bits.
// d is read from the signed challenge payload; [difficulty] (the "difficulty" field of GET /api/challenge) is the fallback.
// scripts/gospel.mjs does this for you; use this only for the manual curl path in references/api.md.
import { createHash } from "node:crypto";

const [challenge, given] = process.argv.slice(2);
if (!challenge) { console.error("usage: node solve-pow.mjs <challenge> [difficulty]"); process.exit(2); }
let d = given === undefined ? undefined : Number(given), e;
try { ({ d = d, e } = JSON.parse(Buffer.from(challenge.split(".")[0], "base64url").toString("utf8"))); } catch {}
if (!Number.isInteger(d) || d < 0 || d > 32) { console.error("Could not read the difficulty; pass it as the second argument."); process.exit(2); }
if (e && e * 1000 < Date.now()) { console.error("Challenge expired. Call GET /api/challenge again."); process.exit(1); }

function zeroBits(h) {
  let bits = 0;
  for (const byte of h) { if (byte === 0) { bits += 8; continue; } return bits + Math.clz32(byte) - 24; }
  return bits;
}
const t0 = Date.now();
let n = 0;
while (zeroBits(createHash("sha256").update(`${challenge}.${n}`).digest()) < d) n++;
console.log(JSON.stringify({ solution: String(n), difficulty_bits: d, seconds: (Date.now() - t0) / 1000 }, null, 2));
