// POST /sessions/{code}/kick — GM ignores (pending) or removes (admitted) a player.
// Soft tombstone, never a hard delete (D21); TTL cleans up.
// Body: { playerId }   Requires a GM token (player token → 403).
// 200: { ok:true, presence }   presence = 'ignored' (was pending) | 'removed'.

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { PlayerPresence } from '../domain/types';
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
    const player = await repo.getPlayer(code, body.playerId);
    if (!player) throw notFound('player not found');

    const presence: PlayerPresence = player.presence === 'pending' ? 'ignored' : 'removed';
    await repo.setPresence(code, body.playerId, presence);
    return json(200, { ok: true, presence });
  } catch (err) {
    return errorResult(err);
  }
};
