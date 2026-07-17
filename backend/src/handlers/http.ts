// Shared HTTP-API-v2 handler utilities: JSON responses, error→status mapping,
// Bearer-token extraction + verification, hashing, id/secret generation, and a
// weak ETag. Backend-only (uses node:crypto + the auth/domain layers).

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { verifyToken } from '../auth/tokens';
import type { TokenClaims } from '../domain/authz';
import type { AppliedCondition } from '../domain/types';

/** Player + GM token lifetime (§12/D13): 48h in seconds. */
export const TOKEN_TTL_SECONDS = 48 * 60 * 60;

/** Error carrying an HTTP status + a stable machine code; mapped by errorResult. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'HttpError';
  }
}

export const badRequest = (m?: string): HttpError => new HttpError(400, 'bad_request', m);
export const unauthorized = (m?: string): HttpError => new HttpError(401, 'unauthorized', m);
export const forbidden = (m?: string): HttpError => new HttpError(403, 'forbidden', m);
export const notFound = (m?: string): HttpError => new HttpError(404, 'not_found', m);

/** Build a JSON HTTP-API-v2 result. */
export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

/** Map a thrown value to a response. HttpError → its status; anything else → 500. */
export function errorResult(err: unknown): APIGatewayProxyStructuredResultV2 {
  if (err instanceof HttpError) return json(err.status, { error: err.code, message: err.message });
  return json(500, { error: 'internal_error' });
}

/** HMAC secret for tokens (env). Throws (→ 500) if unconfigured. */
export function tokenSecret(): string {
  const s = process.env.TOKEN_SECRET;
  if (!s) throw new Error('TOKEN_SECRET is not configured');
  return s;
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function pathParam(event: APIGatewayProxyEventV2, key: string): string | undefined {
  return event.pathParameters?.[key];
}

/**
 * Validate a conditions payload to well-shaped { id, rank? } entries (shape only — ids
 * are NOT cross-checked against the catalog). Malformed entries (non-object / missing id)
 * are dropped gracefully; a non-array top level is a 400; a non-integer rank is a 400.
 * Shared by the player and mob PATCH handlers.
 */
export function normalizeConditions(input: unknown): AppliedCondition[] {
  if (!Array.isArray(input)) throw badRequest('conditions must be an array');
  const out: AppliedCondition[] = [];
  for (const raw of input) {
    if (typeof raw !== 'object' || raw === null) continue;
    const { id, rank } = raw as { id?: unknown; rank?: unknown };
    if (typeof id !== 'string' || id.length === 0) continue;
    const entry: AppliedCondition = { id };
    if (rank !== undefined) {
      if (typeof rank !== 'number' || !Number.isInteger(rank)) {
        throw badRequest('condition rank must be an integer');
      }
      entry.rank = rank;
    }
    out.push(entry);
  }
  return out;
}

/** Parse the JSON body (base64-decoding if flagged). Empty body → {}. Bad JSON → 400. */
export function parseJson<T>(event: APIGatewayProxyEventV2): T {
  if (!event.body) return {} as T;
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw badRequest('invalid JSON body');
  }
}

/** Extract a Bearer token from the Authorization header (HTTP API v2 lowercases keys). */
export function bearer(event: APIGatewayProxyEventV2): string | null {
  const h = event.headers ?? {};
  const raw = h.authorization ?? h.Authorization;
  if (!raw) return null;
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m?.[1] ? m[1].trim() : null;
}

export function ifNoneMatch(event: APIGatewayProxyEventV2): string | null {
  const h = event.headers ?? {};
  return h['if-none-match'] ?? h['If-None-Match'] ?? null;
}

export function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Constant-time compare of two hex digests of equal length. */
export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function newPlayerId(): string {
  return randomUUID();
}

/** One-time join secret handed back at join (only its sha256 is stored). */
export function newJoinSecret(): string {
  return randomBytes(18).toString('base64url');
}

/** Weak ETag over a JSON body for cheap 304s (§8 If-None-Match). */
export function weakETag(body: unknown): string {
  return `W/"${sha256hex(JSON.stringify(body)).slice(0, 27)}"`;
}

/**
 * Verify a Bearer token bound to `code`. 401 on missing/invalid/expired token or a
 * token issued for a different session code. Returns the decoded claims.
 */
export function requireClaims(event: APIGatewayProxyEventV2, code: string): TokenClaims {
  const token = bearer(event);
  if (!token) throw unauthorized('missing bearer token');
  const claims = verifyToken(token, tokenSecret(), nowSec());
  if (!claims) throw unauthorized('invalid or expired token');
  if (claims.code !== code) throw unauthorized('token not valid for this session');
  return claims;
}

/** As requireClaims, but also require role === 'gm' (else 403). */
export function requireGm(event: APIGatewayProxyEventV2, code: string): TokenClaims {
  const claims = requireClaims(event, code);
  if (claims.role !== 'gm') throw forbidden('GM token required');
  return claims;
}
