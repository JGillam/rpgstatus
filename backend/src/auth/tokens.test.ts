import { describe, it, expect } from 'vitest';
import { signToken, verifyToken, generateJoinCode } from './tokens';
import { JOIN_CODE } from '../domain/constants';
import type { TokenClaims } from '../domain/authz';

const SECRET = 'super-secret-hmac-key';
const claims: TokenClaims = { code: 'ABCDE', role: 'player', playerIndex: 2, exp: 2000 };

describe('signToken / verifyToken', () => {
  it('round-trips valid claims', () => {
    const token = signToken(claims, SECRET);
    expect(token).toContain('.');
    expect(verifyToken(token, SECRET, 1000)).toEqual(claims);
  });

  it('rejects a tampered payload', () => {
    const token = signToken(claims, SECRET);
    const forged = signToken({ ...claims, playerIndex: 999 }, SECRET);
    const forgedPayload = forged.split('.')[0]!;
    const originalSig = token.split('.')[1]!;
    // Attacker swaps in different claims but keeps the original signature.
    expect(verifyToken(`${forgedPayload}.${originalSig}`, SECRET, 1000)).toBeNull();
  });

  it('rejects a tampered signature', () => {
    const [payload, sig] = signToken(claims, SECRET).split('.');
    const brokenSig = `${sig!.slice(0, -1)}${sig!.slice(-1) === 'A' ? 'B' : 'A'}`;
    expect(verifyToken(`${payload}.${brokenSig}`, SECRET, 1000)).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const token = signToken(claims, SECRET);
    expect(verifyToken(token, 'other-secret', 1000)).toBeNull();
  });

  it('rejects expired tokens (exp <= now)', () => {
    const token = signToken({ ...claims, exp: 1000 }, SECRET);
    expect(verifyToken(token, SECRET, 1000)).toBeNull(); // exactly equal -> expired
    expect(verifyToken(token, SECRET, 2000)).toBeNull(); // past
    expect(verifyToken(token, SECRET, 999)).not.toBeNull(); // still valid
  });

  it('returns null (never throws) on malformed input', () => {
    const bad = ['', 'nodot', 'a.b.c', '.', 'onlypayload.', '.onlysig', 'not*base64.@@@'];
    for (const t of bad) {
      expect(() => verifyToken(t, SECRET, 0)).not.toThrow();
      expect(verifyToken(t, SECRET, 0)).toBeNull();
    }
  });
});

describe('generateJoinCode', () => {
  it('produces JOIN_CODE.length chars from the alphabet, none ambiguous', () => {
    // Deterministic RNG cycling through every alphabet index across many codes.
    let n = 0;
    const rng = (max: number) => n++ % max;
    for (let k = 0; k < 40; k++) {
      const code = generateJoinCode(rng);
      expect(code).toHaveLength(JOIN_CODE.length);
      for (const ch of code) expect(JOIN_CODE.alphabet).toContain(ch);
      expect(code).not.toMatch(/[IO01]/); // never I / O / 0 / 1
    }
  });

  it('is fully driven by the injected RNG', () => {
    const code = generateJoinCode(() => 0); // always index 0 -> 'A'
    expect(code).toBe('A'.repeat(JOIN_CODE.length));
  });

  it('the alphabet itself excludes I/O/0/1', () => {
    expect(JOIN_CODE.alphabet).not.toMatch(/[IO01]/);
  });
});
