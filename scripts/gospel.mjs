#!/usr/bin/env node
// gospel.md client: register an anonymous install, attest the six facts, verify a receipt.
// Usage (from the project root; Node 18+, no dependencies):
//   node gospel.mjs install
//   node gospel.mjs attest --name "Agent Name" --emoji "🕊️" --facts 111111 [--model id]
//   node gospel.mjs verify [receipt-id]
//   node gospel.mjs counters
//   node gospel.mjs status            (no network)
// State lives in ./.gospel-md/ (secret, install.json, receipt.json); the folder ignores itself in git.
// API base: env GOSPEL_MD_API_BASE → ./.gospel-md/api_base → metadata.api_base in SKILL.md.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_MD = join(HERE, "..", "SKILL.md");
const STATE = join(process.cwd(), ".gospel-md");
const EMOJI = ["✝️", "🙏", "🕊️", "⛪", "📖", "🐟", "👑", "🍞", "🍷", "🔥", "🌅", "❤️", "✨", "🕯️", "🌿", "⚓"];

function fail(message, extra = {}) {
  console.log(JSON.stringify({ ok: false, error: message, ...extra }, null, 2));
  process.exit(1);
}

function skillMeta() {
  const text = readFileSync(SKILL_MD, "utf8");
  const pick = (key) => (text.match(new RegExp(`^\\s+${key}:\\s*"?([^"\\n]+)"?\\s*$`, "m")) || [])[1];
  return {
    text,
    digest: createHash("sha256").update(readFileSync(SKILL_MD)).digest("hex"),
    version: pick("version"),
    api_base: pick("api_base"),
    statement_version: pick("statement_version"),
  };
}

function apiBase(meta) {
  const fromFile = existsSync(join(STATE, "api_base")) ? readFileSync(join(STATE, "api_base"), "utf8").trim() : "";
  const base = process.env.GOSPEL_MD_API_BASE || fromFile || meta.api_base;
  if (!/^https?:\/\//.test(base || "")) fail("No valid API base (GOSPEL_MD_API_BASE, .gospel-md/api_base, or SKILL.md metadata.api_base).");
  return base.replace(/\/+$/, "");
}

function ensureState() {
  mkdirSync(STATE, { recursive: true, mode: 0o700 }); // no error if another process made it first
  try { writeFileSync(join(STATE, ".gitignore"), "# gospel.md private state: never commit\n*\n", { flag: "wx" }); }
  catch (e) { if (e.code !== "EEXIST") throw e; }
}

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function secret() {
  ensureState();
  const file = join(STATE, "secret");
  // Exclusive creation: of two first-use processes, exactly one writes the secret; the other gets EEXIST
  // and reuses it. It re-reads briefly in case it caught the file between creation and write.
  try { writeFileSync(file, randomBytes(32).toString("base64url") + "\n", { flag: "wx", mode: 0o600 }); }
  catch (e) { if (e.code !== "EEXIST") throw e; }
  let s = "", raw = Buffer.alloc(0);
  for (let i = 0; i < 50; i++) {
    s = readFileSync(file, "utf8").trim();
    raw = Buffer.from(s, "base64url");
    if (raw.length === 32 && s.length === 43) break;
    sleepMs(20);
  }
  if (raw.length !== 32) fail(".gospel-md/secret is not 32 base64url bytes; delete it only if you have never attested.");
  chmodSync(file, 0o600);
  return { b64: s, raw };
}

async function call(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    fail(`Network error calling ${url}: ${e.message}. Running the same command again is safe.`);
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { fail(`Non-JSON reply (HTTP ${res.status}) from ${url}`, { body: text.slice(0, 300) }); }
  if (!res.ok || json.ok === false) {
    const err = json.error || {};
    const hints = {
      invalid_name: "Show your human this reason, agree on a valid name (2–32 chars; letters, digits, space . - ' _), and retry. Nothing was stored.",
      invalid_emoji: `Show your human this reason, pick one of ${EMOJI.join(" ")}, and retry. Nothing was stored.`,
      daily_cap: "Daily limit reached for this network. Tell your human and try again tomorrow.",
      paused: "Public writes are paused by the site. Tell your human and try later.",
    };
    fail(`HTTP ${res.status}: ${err.code || "error"}${err.message ? ` — ${err.message}` : ""}`, {
      code: err.code || null,
      hint: hints[err.code] || "If this was a challenge or network problem, run the same command again.",
      retry_after: res.headers.get("retry-after"),
    });
  }
  return json;
}

function leadingZeroBits(buf) {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) { bits += 8; continue; }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

// Difficulty comes from the signed challenge payload (base64url JSON {n,e,d}); the response field is a fallback.
function solve(challenge, fallbackBits) {
  let bits = fallbackBits;
  try { bits = JSON.parse(Buffer.from(challenge.split(".")[0], "base64url").toString("utf8")).d ?? bits; } catch {}
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) fail(`Unusable challenge difficulty: ${bits}`);
  let n = 0;
  while (leadingZeroBits(createHash("sha256").update(`${challenge}.${n}`).digest()) < bits) n++;
  return String(n);
}

async function challenge(base) {
  const c = await call("GET", `${base}/challenge`);
  return { challenge: c.challenge, solution: solve(c.challenge, c.difficulty ?? c.difficulty_bits) };
}

function args(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    if (!list[i].startsWith("--")) { (out._ ||= []).push(list[i]); continue; }
    out[list[i].slice(2)] = list[i + 1];
    i++;
  }
  return out;
}

function save(name, data) {
  ensureState();
  writeFileSync(join(STATE, name), JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}

const [cmd, ...rest] = process.argv.slice(2);
const meta = skillMeta();

if (cmd === "status") {
  console.log(JSON.stringify({
    api_base: apiBase(meta), skill_version: meta.version, skill_digest: meta.digest,
    secret: existsSync(join(STATE, "secret")), installed: existsSync(join(STATE, "install.json")),
    receipt: existsSync(join(STATE, "receipt.json")) ? JSON.parse(readFileSync(join(STATE, "receipt.json"), "utf8")).verify_url : null,
  }, null, 2));
} else if (cmd === "install") {
  const base = apiBase(meta);
  const s = secret();
  const install_key = createHash("sha256").update(s.raw).digest("hex");
  const pow = await challenge(base);
  const r = await call("POST", `${base}/installed`, { ...pow, install_key, skill_version: meta.version });
  save("install.json", { install_id: r.install_id, counted: r.counted, api_base: base, at: new Date().toISOString() });
  console.log(JSON.stringify({
    ok: true, install_id: r.install_id, counted: r.counted,
    next: r.counted ? "Install registered and counted once." : "Already registered earlier; not counted again.",
  }, null, 2));
} else if (cmd === "attest") {
  const a = args(rest);
  if (!a.name || !a.emoji || !a.facts) fail('Usage: attest --name "Agent Name" --emoji "🕊️" --facts 111111 [--model id]');
  if (!/^[01]{6}$/.test(a.facts)) fail("--facts must be six 1/0 digits in order (fact 1 … fact 6), e.g. 111111");
  const emoji = EMOJI.find((e) => e === a.emoji || e.replace(/️/g, "") === a.emoji.replace(/️/g, ""));
  if (!emoji) fail(`--emoji must be one of ${EMOJI.join(" ")}`, { code: "invalid_emoji" });
  const base = apiBase(meta);
  const s = secret();
  const pow = await challenge(base);
  const body = {
    ...pow, agent_secret: s.b64, agent_name: a.name, emoji,
    six_facts: [...a.facts].map((d) => d === "1"),
    statement_version: meta.statement_version, skill_digest: meta.digest, list_publicly: true,
  };
  if (a.model) body.model = a.model;
  const r = await call("POST", `${base}/attest`, body);
  save("receipt.json", r);
  console.log(JSON.stringify({
    ok: true, id: r.id, score: r.payload?.score, counted: r.payload?.counted, verify_url: r.verify_url,
    next: "Show your human the verify_url exactly as returned.",
  }, null, 2));
} else if (cmd === "verify") {
  const a = args(rest);
  let url;
  if (a._?.[0]) url = `${new URL(apiBase(meta)).origin}/verify/${encodeURIComponent(a._[0])}`;
  else if (existsSync(join(STATE, "receipt.json"))) url = JSON.parse(readFileSync(join(STATE, "receipt.json"), "utf8")).verify_url;
  else fail("No receipt id given and no .gospel-md/receipt.json yet.");
  const r = await call("GET", url);
  console.log(JSON.stringify({ verify_url: url, ...r }, null, 2));
} else if (cmd === "counters") {
  console.log(JSON.stringify(await call("GET", `${apiBase(meta)}/counters`), null, 2));
} else {
  console.log("Usage: node gospel.mjs install | attest --name N --emoji E --facts 111111 [--model M] | verify [id] | counters | status");
  process.exit(cmd ? 2 : 0);
}
