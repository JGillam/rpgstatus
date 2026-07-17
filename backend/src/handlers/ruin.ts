// POST /sessions/{code}/ruin — raise/lower the shared Ruin pool (§5.4, D16).
// Body: { delta }  (typically +1 / −1).
// Auth: GM ONLY (authorize kind:'ruin'). A player token → 403; invalid/expired/wrong-code
// token → 401. The add floors at 0 (D16); a log entry (type 'R', attributed to the GM,
// actor index 0) is then appended. 200: { ruin: <new value> }

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
    if (!authorize(claims, { kind: 'ruin' })) throw forbidden('Ruin is GM-only');

    const body = parseJson<{ delta?: unknown }>(event);
    if (typeof body.delta !== 'number' || !Number.isInteger(body.delta)) {
      throw badRequest('delta must be an integer');
    }

    const repo = new Repo(docClient);
    const ruin = await repo.addRuin(code, body.delta); // atomic ADD, floored at 0 (D16)
    await repo.appendLogEntry(code, encodeLog(0, body.delta, 'R', nowSec()));

    return json(200, { ruin });
  } catch (err) {
    return errorResult(err);
  }
};
