// Backend-only auth primitives (§12, D13, D20). This module MAY use `node:crypto`.
// It depends on the pure domain layer (types/constants), never the reverse —
// domain/* must NEVER import auth/*.

import { createHmac, randomInt as cryptoRandomInt, timingSafeEqual } from 'node:crypto';
import { JOIN_CODE } from '../domain/constants';
import type { TokenClaims } from '../domain/authz';

/** base64url-encode a UTF-8 string. */
function encodePayload(claims: TokenClaims): string {
  return Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
}

/** Structural guard for a decoded token payload. */
function isTokenClaims(v: unknown): v is TokenClaims {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.code !== 'string') return false;
  if (o.role !== 'gm' && o.role !== 'player') return false;
  if (o.playerIndex !== undefined && typeof o.playerIndex !== 'number') return false;
  if (typeof o.exp !== 'number') return false;
  return true;
}

/**
 * Sign claims into `base64url(payload).base64url(HMAC_SHA256(payload, secret))` (§12).
 * The HMAC is computed over the base64url payload string.
 */
export function signToken(claims: TokenClaims, secret: string): string {
  const payload = encodePayload(claims);
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/**
 * Verify a token and return its claims, or null. NEVER throws.
 * Returns null on malformed input, signature mismatch, or expiry (`exp <= nowSec`).
 * Signature comparison is constant-time via `crypto.timingSafeEqual`.
 */
export function verifyToken(token: string, secret: string, nowSec: number): TokenClaims | null {
  try {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [payload, sig] = parts;
    if (!payload || !sig) return null;

    const expected = createHmac('sha256', secret).update(payload).digest();
    const provided = Buffer.from(sig, 'base64url');
    // timingSafeEqual requires equal-length buffers; a length mismatch is itself a mismatch.
    if (provided.length !== expected.length) return null;
    if (!timingSafeEqual(provided, expected)) return null;

    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!isTokenClaims(claims)) return null;
    if (claims.exp <= nowSec) return null;
    return claims;
  } catch {
    return null;
  }
}

/**
 * Generate a join code: `JOIN_CODE.length` chars from the unambiguous alphabet (no I/O/0/1, D20).
 * `randomInt` is injectable for deterministic tests; defaults to crypto.randomInt.
 */
export function generateJoinCode(
  randomInt: (maxExclusive: number) => number = cryptoRandomInt,
): string {
  const { length, alphabet } = JOIN_CODE;
  let code = '';
  for (let i = 0; i < length; i++) {
    code += alphabet.charAt(randomInt(alphabet.length));
  }
  return code;
}
