// PATCH /sessions/{code} — GM edits absolute session-meta fields (§5, D16).
// Body: a subset of { glory?, ruin?, showRuin?, round?, chapterName? }.
//   glory / ruin are floored at 0, round at 1 (absolute sets, not deltas).
//   showRuin toggles player visibility of Ruin; chapterName renames settings.chapterName.
// Auth: GM ONLY (authorize kind:'session'). Player token → 403; invalid/expired/wrong-code
// token → 401; 404 if the session is gone. 200: { session: <mapped SessionMeta> }

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { authorize } from '../domain/authz';
import { DEFAULTS, LIMITS } from '../domain/constants';
import { docClient } from '../data/client';
import { Repo, type SessionPatch } from '../data/repo';
import {
  badRequest,
  errorResult,
  forbidden,
  json,
  notFound,
  parseJson,
  pathParam,
  requireClaims,
} from './http';

interface UpdateBody {
  glory?: unknown;
  ruin?: unknown;
  showRuin?: unknown;
  round?: unknown;
  chapterName?: unknown;
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  try {
    const code = pathParam(event, 'code');
    if (!code) throw badRequest('missing session code');

    const claims = requireClaims(event, code); // 401 on invalid / expired / wrong code
    if (!authorize(claims, { kind: 'session' })) throw forbidden('editing the session is GM-only');

    const body = parseJson<UpdateBody>(event);
    const patch: SessionPatch = {};

    if (body.glory !== undefined) {
      if (typeof body.glory !== 'number' || !Number.isInteger(body.glory)) {
        throw badRequest('glory must be an integer');
      }
      patch.glory = Math.max(LIMITS.counter.min, body.glory); // floor at 0 (D16)
    }
    if (body.ruin !== undefined) {
      if (typeof body.ruin !== 'number' || !Number.isInteger(body.ruin)) {
        throw badRequest('ruin must be an integer');
      }
      patch.ruin = Math.max(LIMITS.counter.min, body.ruin); // floor at 0 (D16)
    }
    if (body.showRuin !== undefined) {
      if (typeof body.showRuin !== 'boolean') throw badRequest('showRuin must be a boolean');
      patch.showRuin = body.showRuin;
    }
    if (body.round !== undefined) {
      if (typeof body.round !== 'number' || !Number.isInteger(body.round)) {
        throw badRequest('round must be an integer');
      }
      patch.round = Math.max(1, body.round); // rounds are 1-based
    }
    if (body.chapterName !== undefined) {
      if (typeof body.chapterName !== 'string') throw badRequest('chapterName must be a string');
      const trimmed = body.chapterName.trim();
      if (trimmed.length > LIMITS.chapterName.max) {
        throw badRequest(`chapterName must be <= ${LIMITS.chapterName.max} chars`);
      }
      patch.chapterName = trimmed.length > 0 ? trimmed : DEFAULTS.chapterNameFallback;
    }

    const repo = new Repo(docClient);
    const session = await repo.updateSession(code, patch);
    if (!session) throw notFound('session not found');

    return json(200, { session });
  } catch (err) {
    return errorResult(err);
  }
};
