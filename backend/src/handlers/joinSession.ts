// POST /sessions/{code}/join — create a pending player, hand back a one-time secret (§10.2).
// Body: { name }
// 200: { playerId, joinSecret }   404 if no active session.

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { LIMITS } from '../domain/constants';
import { docClient } from '../data/client';
import { Repo, SESSION_TTL_SECONDS } from '../data/repo';
import {
  badRequest,
  errorResult,
  json,
  newJoinSecret,
  newPlayerId,
  notFound,
  parseJson,
  pathParam,
  sha256hex,
} from './http';

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  try {
    const code = pathParam(event, 'code');
    if (!code) throw badRequest('missing session code');

    const body = parseJson<{ name?: unknown }>(event);
    if (typeof body.name !== 'string') throw badRequest('name is required');
    const name = body.name.trim();
    if (name.length < LIMITS.name.min || name.length > LIMITS.name.max) {
      throw badRequest(`name must be ${LIMITS.name.min}-${LIMITS.name.max} characters`);
    }

    const repo = new Repo(docClient);
    const meta = await repo.getMeta(code);
    if (!meta || meta.state !== 'active') throw notFound('no active session for that code');

    const playerId = newPlayerId();
    const joinSecret = newJoinSecret();
    await repo.createPlayer(code, {
      id: playerId,
      name,
      joinSecretHash: sha256hex(joinSecret),
      ttlSec: SESSION_TTL_SECONDS,
    });

    return json(200, { playerId, joinSecret });
  } catch (err) {
    return errorResult(err);
  }
};
