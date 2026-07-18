// PATCH /sessions/{code}/players/{playerId} — edit a character's mutable fields (§5, D16).
// Body: a subset of { maxWounds?, wounds?, maxShock?, shock?, wrath?, status?, actedThisRound?, conditions? }.
//   maxWounds/maxShock are the character-setup tracks (clamped to LIMITS); raising or
//   lowering a max re-clamps the stored current track so it can never exceed the new max.
// Auth: a player may edit ONLY their own character; the GM may edit any (authorize).
//   401 invalid/expired/wrong-code token · 404 no such player · 403 wrong player.
// 200: { player: <mapped Player> }

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { authorize } from '../domain/authz';
import { clamp, clampCurrent, clampWrath } from '../domain/logic';
import { LIMITS } from '../domain/constants';
import type { PlayerStatus } from '../domain/types';
import { docClient } from '../data/client';
import { Repo, type PlayerPatch } from '../data/repo';
import {
  badRequest,
  errorResult,
  forbidden,
  json,
  normalizeConditions,
  notFound,
  parseJson,
  pathParam,
  requireClaims,
} from './http';

/** The PlayerStatus union as a runtime guard set (types.ts §5). */
const STATUSES: readonly PlayerStatus[] = ['active', 'down', 'dying', 'dead', 'stable'];

interface UpdateBody {
  maxWounds?: unknown;
  wounds?: unknown;
  maxShock?: unknown;
  shock?: unknown;
  wrath?: unknown;
  status?: unknown;
  actedThisRound?: unknown;
  conditions?: unknown;
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

    // Character-setup maxes first: a new max (clamped to LIMITS) re-clamps the stored
    // current track down so it can never exceed the max. The effective maxes then bound
    // any explicit wounds/shock in the same patch below (max change applies first).
    let maxWounds = target.maxWounds;
    let maxShock = target.maxShock;
    if (body.maxWounds !== undefined) {
      if (typeof body.maxWounds !== 'number' || !Number.isInteger(body.maxWounds)) {
        throw badRequest('maxWounds must be an integer');
      }
      maxWounds = clamp(body.maxWounds, LIMITS.maxWounds.min, LIMITS.maxWounds.max);
      patch.maxWounds = maxWounds;
      patch.wounds = clampCurrent(target.wounds, maxWounds);
    }
    if (body.maxShock !== undefined) {
      if (typeof body.maxShock !== 'number' || !Number.isInteger(body.maxShock)) {
        throw badRequest('maxShock must be an integer');
      }
      maxShock = clamp(body.maxShock, LIMITS.maxShock.min, LIMITS.maxShock.max);
      patch.maxShock = maxShock;
      patch.shock = clampCurrent(target.shock, maxShock);
    }

    if (body.wounds !== undefined) {
      if (typeof body.wounds !== 'number' || !Number.isInteger(body.wounds)) {
        throw badRequest('wounds must be an integer');
      }
      patch.wounds = clampCurrent(body.wounds, maxWounds);
    }
    if (body.shock !== undefined) {
      if (typeof body.shock !== 'number' || !Number.isInteger(body.shock)) {
        throw badRequest('shock must be an integer');
      }
      patch.shock = clampCurrent(body.shock, maxShock);
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
