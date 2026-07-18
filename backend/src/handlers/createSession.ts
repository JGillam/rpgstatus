// POST /sessions — create a live session + issue the GM token (§10.1, D22).
// Body: { chapterName?, glory?, ruin?, showRuin? }
// 200: { code, role:'gm', gmToken, state: GmSnapshot }

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { generateJoinCode, signToken } from '../auth/tokens';
import { DEFAULTS, LIMITS } from '../domain/constants';
import type { GmSnapshot, SessionMeta } from '../domain/types';
import { docClient } from '../data/client';
import { Repo, SESSION_TTL_SECONDS } from '../data/repo';
import {
  badRequest,
  errorResult,
  json,
  nowSec,
  parseJson,
  sha256hex,
  TOKEN_TTL_SECONDS,
  tokenSecret,
} from './http';

interface CreateBody {
  chapterName?: unknown;
  glory?: unknown;
  ruin?: unknown;
  showRuin?: unknown;
}

/** Coerce an optional counter input to a non-negative integer (D16 floor). */
function counter(v: unknown, field: string): number {
  if (v === undefined) return 0;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < LIMITS.counter.min) {
    throw badRequest(`${field} must be an integer >= ${LIMITS.counter.min}`);
  }
  return v;
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  try {
    const body = parseJson<CreateBody>(event);

    let chapterName: string = DEFAULTS.chapterNameFallback;
    if (body.chapterName !== undefined) {
      if (typeof body.chapterName !== 'string') throw badRequest('chapterName must be a string');
      const trimmed = body.chapterName.trim();
      if (trimmed.length > LIMITS.chapterName.max) {
        throw badRequest(`chapterName must be <= ${LIMITS.chapterName.max} chars`);
      }
      chapterName = trimmed.length > 0 ? trimmed : DEFAULTS.chapterNameFallback;
    }

    const glory = counter(body.glory, 'glory');
    const ruin = counter(body.ruin, 'ruin');
    let showRuin: boolean = DEFAULTS.session.showRuin;
    if (body.showRuin !== undefined) {
      if (typeof body.showRuin !== 'boolean') throw badRequest('showRuin must be a boolean');
      showRuin = body.showRuin;
    }

    const repo = new Repo(docClient);

    // Allocate a unique join code, retrying on the (rare) collision via getMeta.
    let code = '';
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = generateJoinCode();
      if (!(await repo.getMeta(candidate))) {
        code = candidate;
        break;
      }
    }
    if (!code) throw new Error('could not allocate a unique join code');

    const now = nowSec();
    const meta: SessionMeta = {
      code,
      state: 'active',
      glory,
      ruin,
      showRuin,
      round: 1,
      settings: { chapterName },
      createdAt: now,
      expiresAt: now + SESSION_TTL_SECONDS,
    };

    const gmToken = signToken({ code, role: 'gm', exp: now + TOKEN_TTL_SECONDS }, tokenSecret());
    await repo.putSession(meta, sha256hex(gmToken), SESSION_TTL_SECONDS);

    const snapshot: GmSnapshot = { session: meta, players: [], mobs: [], log: [] };
    return json(200, { code, role: 'gm', gmToken, state: snapshot });
  } catch (err) {
    return errorResult(err);
  }
};
