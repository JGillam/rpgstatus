// POST /sessions/{code}/claim — the waiting player polls with its one-time secret.
// Body: { playerId, joinSecret }
// 200: { presence }                              (pending / ignored / removed)
// 200: { presence:'admitted', playerToken, index }  once the GM admits them.
//
// This is how a player obtains its token: it is NOT returned at join. The player
// holds only the join secret and polls claim; the token is minted here, the first
// time claim sees presence === 'admitted'.

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { signToken } from '../auth/tokens';
import { docClient } from '../data/client';
import { Repo } from '../data/repo';
import {
  badRequest,
  errorResult,
  forbidden,
  json,
  notFound,
  nowSec,
  parseJson,
  pathParam,
  safeEqualHex,
  sha256hex,
  TOKEN_TTL_SECONDS,
  tokenSecret,
} from './http';

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  try {
    const code = pathParam(event, 'code');
    if (!code) throw badRequest('missing session code');

    const body = parseJson<{ playerId?: unknown; joinSecret?: unknown }>(event);
    if (typeof body.playerId !== 'string' || typeof body.joinSecret !== 'string') {
      throw badRequest('playerId and joinSecret are required');
    }

    const repo = new Repo(docClient);
    const player = await repo.getPlayerRaw(code, body.playerId);
    if (!player) throw notFound('player not found');
    if (!safeEqualHex(sha256hex(body.joinSecret), player.joinSecretHash)) {
      throw forbidden('join secret does not match');
    }

    if (player.presence !== 'admitted') {
      return json(200, { presence: player.presence });
    }

    const playerToken = signToken(
      { code, role: 'player', playerIndex: player.index, exp: nowSec() + TOKEN_TTL_SECONDS },
      tokenSecret(),
    );
    return json(200, { presence: 'admitted', playerToken, index: player.index });
  } catch (err) {
    return errorResult(err);
  }
};
