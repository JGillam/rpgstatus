// POST /sessions/{code}/end — GM ends the session (§10, D22). Sets state='ended'
// (the item lingers until TTL; clients derive 'expired' only once it's gone).
// Auth: GM ONLY (authorize kind:'session'). Player token → 403; invalid/expired/wrong-code
// token → 401. 200: { ok:true, state:'ended' }

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
    if (!authorize(claims, { kind: 'session' })) throw forbidden('ending the session is GM-only');

    const repo = new Repo(docClient);
    await repo.updateSession(code, { state: 'ended' });

    return json(200, { ok: true, state: 'ended' });
  } catch (err) {
    return errorResult(err);
  }
};
