// PATCH /sessions/{code}/players/{playerId} — edit a character's mutable fields (§5, D16).
// Body: a subset of { wounds?, shock?, wrath?, status?, actedThisRound?, conditions? }.
// Auth: a player may edit ONLY their own character; the GM may edit any (authorize).
//   401 invalid/expired/wrong-code token · 404 no such player · 403 wrong player.
// 200: { player: <mapped Player> }

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { authorize } from '../domain/authz';
import { clampCurrent, clampWrath } from '../domain/logic';
import type { AppliedCondition, PlayerStatus } from '../domain/types';
import { docClient } from '../data/client';
import { Repo, type PlayerPatch } from '../data/repo';
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

/** The PlayerStatus union as a runtime guard set (types.ts §5). */
const STATUSES: readonly PlayerStatus[] = ['active', 'down', 'dying', 'dead', 'stable'];

interface UpdateBody {
  wounds?: unknown;
  shock?: unknown;
  wrath?: unknown;
  status?: unknown;
  actedThisRound?: unknown;
  conditions?: unknown;
}

/**
 * Validate a conditions payload to well-shaped { id, rank? } entries. Shape only —
 * unknown ids are NOT cross-checked against the catalog; malformed entries (non-object
 * / missing id) are dropped gracefully. A non-array top level is a 400.
 */
function normalizeConditions(input: unknown): AppliedCondition[] {
  if (!Array.isArray(input)) throw badRequest('conditions must be an array');
  const out: AppliedCondition[] = [];
  for (const raw of input) {
    if (typeof raw !== 'object' || raw === null) continue;
    const { id, rank } = raw as { id?: unknown; rank?: unknown };
    if (typeof id !== 'string' || id.length === 0) continue;
    const entry: AppliedCondition = { id };
    if (rank !== undefined) {
      if (typeof rank !== 'number' || !Number.isInteger(rank)) {
        throw badRequest('condition rank must be an integer');
      }
      entry.rank = rank;
    }
    out.push(entry);
  }
  return out;
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  try {
    const code = pathParam(event, 'code');
    const playerId = pathParam(event, 'playerId');
    if (!code) throw badRequest('missing session code');
    if (!playerId) throw badRequest('missing player id');

    const claims = requireClaims(event, code); // 401 on invalid / expired / wrong code

    const repo = new Repo(docClient);
    const target = await repo.getPlayer(code, playerId);
    if (!target) throw notFound('player not found');

    // A player edits only their own character; the GM edits any (§4 matrix).
    if (!authorize(claims, { kind: 'player', playerIndex: target.index })) {
      throw forbidden('not allowed to edit this character');
    }

    const body = parseJson<UpdateBody>(event);
    const patch: PlayerPatch = {};

    if (body.wounds !== undefined) {
      if (typeof body.wounds !== 'number' || !Number.isInteger(body.wounds)) {
        throw badRequest('wounds must be an integer');
      }
      patch.wounds = clampCurrent(body.wounds, target.maxWounds);
    }
    if (body.shock !== undefined) {
      if (typeof body.shock !== 'number' || !Number.isInteger(body.shock)) {
        throw badRequest('shock must be an integer');
      }
      patch.shock = clampCurrent(body.shock, target.maxShock);
    }
    if (body.wrath !== undefined) {
      if (typeof body.wrath !== 'number' || !Number.isInteger(body.wrath)) {
        throw badRequest('wrath must be an integer');
      }
      patch.wrath = clampWrath(body.wrath);
    }
    if (body.status !== undefined) {
      if (typeof body.status !== 'string' || !STATUSES.includes(body.status as PlayerStatus)) {
        throw badRequest('status must be one of: ' + STATUSES.join(', '));
      }
      patch.status = body.status as PlayerStatus;
    }
    if (body.actedThisRound !== undefined) {
      if (typeof body.actedThisRound !== 'boolean') throw badRequest('actedThisRound must be a boolean');
      patch.actedThisRound = body.actedThisRound;
    }
    if (body.conditions !== undefined) {
      patch.conditions = normalizeConditions(body.conditions);
    }

    const updated = await repo.updatePlayer(code, playerId, patch);
    if (!updated) throw notFound('player not found');
    return json(200, { player: updated });
  } catch (err) {
    return errorResult(err);
  }
};
