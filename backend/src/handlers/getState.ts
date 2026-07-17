// GET /state/{code} — hydrate the board for the token holder (§9.1, §8, §12).
//   GM token    → full GmSnapshot.
//   Player token → projectForPlayer(...) — coarse mobs only, hidden mobs dropped,
//                  exact HP / mob acted flags never sent, Ruin nulled unless shown.
// 401 invalid/expired/wrong-code token; 404 if the session is gone.
// Weak ETag + If-None-Match → 304.

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { projectForPlayer } from '../domain/logic';
import type { GmSnapshot, PlayerSnapshot } from '../domain/types';
import { docClient } from '../data/client';
import { Repo } from '../data/repo';
import {
  badRequest,
  errorResult,
  ifNoneMatch,
  json,
  notFound,
  pathParam,
  requireClaims,
  unauthorized,
  weakETag,
} from './http';

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  try {
    const code = pathParam(event, 'code');
    if (!code) throw badRequest('missing session code');

    const claims = requireClaims(event, code); // 401 on invalid / expired / wrong code

    const repo = new Repo(docClient);
    const hydrated = await repo.hydrate(code);
    if (!hydrated) throw notFound('session not found');

    const snapshot: GmSnapshot = {
      session: hydrated.meta,
      players: hydrated.players,
      mobs: hydrated.mobs,
      log: hydrated.log,
    };

    let body: GmSnapshot | PlayerSnapshot;
    if (claims.role === 'gm') {
      body = snapshot;
    } else {
      const idx = claims.playerIndex;
      const you = idx !== undefined ? hydrated.players.find((p) => p.index === idx) : undefined;
      if (!you) throw unauthorized('token does not match an admitted player');
      // SECURITY: projectForPlayer strips exact HP / hidden mobs / mob acted flags and nulls Ruin.
      body = projectForPlayer(snapshot, you.id);
    }

    const etag = weakETag(body);
    if (ifNoneMatch(event) === etag) {
      return { statusCode: 304, headers: { etag } };
    }
    return json(200, body, { etag });
  } catch (err) {
    return errorResult(err);
  }
};
