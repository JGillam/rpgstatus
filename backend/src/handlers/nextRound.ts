// POST /sessions/{code}/round/next — advance to the next round (§5, D15).
// Clears actedThisRound on every player AND mob, then bumps the round counter.
// Auth: GM ONLY (authorize kind:'round'). Player token → 403; invalid/expired/wrong-code
// token → 401. 200: { round: <new value> }

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { authorize } from '../domain/authz';
import { docClient } from '../data/client';
import { Repo } from '../data/repo';
import { badRequest, errorResult, forbidden, json, pathParam, requireClaims } from './http';

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  try {
    const code = pathParam(event, 'code');
    if (!code) throw badRequest('missing session code');

    const claims = requireClaims(event, code); // 401 on invalid / expired / wrong code
    if (!authorize(claims, { kind: 'round' })) throw forbidden('advancing the round is GM-only');

    const repo = new Repo(docClient);
    const round = await repo.advanceRound(code);

    return json(200, { round });
  } catch (err) {
    return errorResult(err);
  }
};
