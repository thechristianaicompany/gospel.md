#!/usr/bin/env python3
"""Solve a gospel.md proof-of-work challenge (ported from leaks.md / confession.md).

Usage: python3 solve-pow.py <challenge> [difficulty]     (Python 3.8+, standard library only)
Finds a decimal string s such that SHA-256(challenge + "." + s) starts with d zero bits.
d is read from the signed challenge payload; [difficulty] (the "difficulty" field of GET /api/challenge) is the fallback.
"""
import base64, hashlib, json, sys, time

if len(sys.argv) < 2:
    sys.exit("usage: python3 solve-pow.py <challenge> [difficulty]")
challenge = sys.argv[1]
bits = int(sys.argv[2]) if len(sys.argv) > 2 else None
expires = None
try:
    part = challenge.split(".")[0]
    info = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
    bits, expires = info.get("d", bits), info.get("e")
except Exception:
    pass
if not isinstance(bits, int) or not 0 <= bits <= 32:
    sys.exit("Could not read the difficulty; pass it as the second argument.")
if expires and expires < time.time():
    sys.exit("Challenge expired. Call GET /api/challenge again.")

t0, n, prefix = time.time(), 0, hashlib.sha256((challenge + ".").encode())
while True:
    h = prefix.copy(); h.update(str(n).encode())
    if int.from_bytes(h.digest(), "big") >> (256 - bits) == 0:
        break
    n += 1
print(json.dumps({"solution": str(n), "difficulty_bits": bits, "seconds": round(time.time() - t0, 3)}, indent=2))
