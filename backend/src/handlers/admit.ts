// POST /sessions/{code}/admit — GM admits a pending player (§10.3, D21).
// Body: { playerId }   Requires a GM token (player token → 403).
// 200: { ok:true, index }

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { docClient } from '../data/client';
import { Repo } from '../data/repo';
import {
  badRequest,
  errorResult,
  json,
  notFound,
  parseJson,
  pathParam,
  requireGm,
} from './http';

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  try {
    const code = pathParam(event, 'code');
    if (!code) throw badRequest('missing session code');
    requireGm(event, code);

    const body = parseJson<{ playerId?: unknown }>(event);
    if (typeof body.playerId !== 'string') throw badRequest('playerId is required');

    const repo = new Repo(docClient);
    if (!(await repo.getMeta(code))) throw notFound('session not found');

    const player = await repo.getPlayer(code, body.playerId);
    if (!player) throw notFound('player not found');

    // Idempotent: re-admitting keeps the already-assigned index.
    if (player.presence === 'admitted') {
      return json(200, { ok: true, index: player.index });
    }

    const index = await repo.allocateIndexAndAdmit(code, body.playerId);
    return json(200, { ok: true, index });
  } catch (err) {
    return errorResult(err);
  }
};
