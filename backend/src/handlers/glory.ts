// POST /sessions/{code}/glory — push/pull the shared Glory pool (§5.4, D16).
// Body: { delta }  (typically +1 / −1).
// Auth: ANY valid token bound to the session — player OR GM (Glory is shared,
// authorize kind:'glory'). The add floors at 0 (D16); a log entry is then appended,
// attributed to the actor (GM → index 0, player → its assigned index).
// 401 invalid/expired/wrong-code token.  200: { glory: <new value> }

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { authorize } from '../domain/authz';
import { encodeLog } from '../domain/logic';
import { docClient } from '../data/client';
import { Repo } from '../data/repo';
import {
  badRequest,
  errorResult,
  forbidden,
  json,
  nowSec,
  parseJson,
  pathParam,
  requireClaims,
} from './http';

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  try {
    const code = pathParam(event, 'code');
    if (!code) throw badRequest('missing session code');

    const claims = requireClaims(event, code); // 401 on invalid / expired / wrong code
    if (!authorize(claims, { kind: 'glory' })) throw forbidden('not allowed to change Glory');

    const body = parseJson<{ delta?: unknown }>(event);
    if (typeof body.delta !== 'number' || !Number.isInteger(body.delta)) {
      throw badRequest('delta must be an integer');
    }

    const repo = new Repo(docClient);
    const glory = await repo.addGlory(code, body.delta); // atomic ADD, floored at 0 (D16)

    // Attribute the entry to the actor: GM → 0, player → its assigned index.
    const actorIndex = claims.role === 'gm' ? 0 : claims.playerIndex ?? 0;
    await repo.appendLogEntry(code, encodeLog(actorIndex, body.delta, 'G', nowSec()));

    return json(200, { glory });
  } catch (err) {
    return errorResult(err);
  }
};
