// Mob management — ONE handler dispatching on method + path params (§5, §7). All
// operations are GM ONLY (authorize kind:'mob'); a player token → 403, an
// invalid/expired/wrong-code token → 401. Routes wired to this fn:
//   POST   /sessions/{code}/mobs                    → add N mobs      → { mobs:[Mob...] }
//   PATCH  /sessions/{code}/mobs/{mobId}            → edit one mob    → { mob:Mob }
//   DELETE /sessions/{code}/mobs/{mobId}            → remove one mob  → { ok:true }
//   POST   /sessions/{code}/mobs/{mobId}/duplicate  → copy one mob    → { mob:Mob }

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { authorize } from '../domain/authz';
import { DEFAULTS, LIMITS } from '../domain/constants';
import { clamp } from '../domain/logic';
import type { MobTier } from '../domain/types';
import { docClient } from '../data/client';
import { Repo, type MobPatch, type MobSpec } from '../data/repo';
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

/** The MobTier union as a runtime guard set (types.ts §5). */
const TIERS: readonly MobTier[] = ['Troops', 'Elite', 'Adversary'];

interface CreateBody {
  label?: unknown;
  tier?: unknown;
  maxHp?: unknown;
  count?: unknown;
  startsHidden?: unknown;
}

interface PatchBody {
  label?: unknown;
  tier?: unknown;
  maxHp?: unknown;
  hp?: unknown;
  revealed?: unknown;
  actedThisRound?: unknown;
  conditions?: unknown;
}

function requireTier(v: unknown): MobTier {
  if (typeof v !== 'string' || !TIERS.includes(v as MobTier)) {
    throw badRequest('tier must be one of: ' + TIERS.join(', '));
  }
  return v as MobTier;
}

function requireLabel(v: unknown): string {
  if (typeof v !== 'string') throw badRequest('label must be a string');
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : DEFAULTS.mob.label;
}

/** POST /mobs — create `count` mobs (count clamped 1..8, maxHp floored at 1). */
async function createMobs(
  event: APIGatewayProxyEventV2,
  repo: Repo,
  code: string,
): Promise<APIGatewayProxyStructuredResultV2> {
  const body = parseJson<CreateBody>(event);

  const label = body.label !== undefined ? requireLabel(body.label) : DEFAULTS.mob.label;
  const tier = body.tier !== undefined ? requireTier(body.tier) : DEFAULTS.mob.tier;

  let maxHp: number = DEFAULTS.mob.maxHp;
  if (body.maxHp !== undefined) {
    if (typeof body.maxHp !== 'number' || !Number.isInteger(body.maxHp)) {
      throw badRequest('maxHp must be an integer');
    }
    maxHp = body.maxHp;
  }
  maxHp = Math.max(LIMITS.mobMaxHp.min, maxHp); // floor at 1

  let count: number = DEFAULTS.mob.count;
  if (body.count !== undefined) {
    if (typeof body.count !== 'number' || !Number.isInteger(body.count)) {
      throw badRequest('count must be an integer');
    }
    count = body.count;
  }
  count = clamp(count, LIMITS.addMobCount.min, LIMITS.addMobCount.max); // 1..8

  let startsHidden: boolean = DEFAULTS.mob.startsHidden;
  if (body.startsHidden !== undefined) {
    if (typeof body.startsHidden !== 'boolean') throw badRequest('startsHidden must be a boolean');
    startsHidden = body.startsHidden;
  }

  const spec: MobSpec = { label, tier, maxHp, startsHidden };
  const mobs = await repo.addMobs(code, spec, count);
  return json(200, { mobs });
}

/** PATCH /mobs/{mobId} — edit one mob (hp clamped to 0..maxHp). */
async function patchMob(
  event: APIGatewayProxyEventV2,
  repo: Repo,
  code: string,
  mobId: string,
): Promise<APIGatewayProxyStructuredResultV2> {
  const existing = await repo.getMob(code, mobId);
  if (!existing) throw notFound('mob not found');

  const body = parseJson<PatchBody>(event);
  const patch: MobPatch = {};

  if (body.label !== undefined) patch.label = requireLabel(body.label);
  if (body.tier !== undefined) patch.tier = requireTier(body.tier);

  let maxHp = existing.maxHp;
  if (body.maxHp !== undefined) {
    if (typeof body.maxHp !== 'number' || !Number.isInteger(body.maxHp)) {
      throw badRequest('maxHp must be an integer');
    }
    maxHp = Math.max(LIMITS.mobMaxHp.min, body.maxHp);
    patch.maxHp = maxHp;
  }
  if (body.hp !== undefined) {
    if (typeof body.hp !== 'number' || !Number.isInteger(body.hp)) {
      throw badRequest('hp must be an integer');
    }
    patch.hp = clamp(body.hp, 0, maxHp); // clamp to the new-or-existing maxHp
  }
  if (body.revealed !== undefined) {
    if (typeof body.revealed !== 'boolean') throw badRequest('revealed must be a boolean');
    patch.revealed = body.revealed;
  }
  if (body.actedThisRound !== undefined) {
    if (typeof body.actedThisRound !== 'boolean') throw badRequest('actedThisRound must be a boolean');
    patch.actedThisRound = body.actedThisRound;
  }
  if (body.conditions !== undefined) {
    patch.conditions = normalizeConditions(body.conditions);
  }

  const mob = await repo.updateMob(code, mobId, patch);
  if (!mob) throw notFound('mob not found');
  return json(200, { mob });
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  try {
    const code = pathParam(event, 'code');
    if (!code) throw badRequest('missing session code');

    const claims = requireClaims(event, code); // 401 on invalid / expired / wrong code
    if (!authorize(claims, { kind: 'mob' })) throw forbidden('mob management is GM-only');

    const method = event.requestContext?.http?.method;
    if (!method) throw badRequest('missing request method');
    const mobId = pathParam(event, 'mobId');
    const repo = new Repo(docClient);

    // POST /mobs (no mobId) creates; POST /mobs/{mobId} is the /duplicate route.
    if (method === 'POST' && !mobId) return await createMobs(event, repo, code);
    if (method === 'POST' && mobId) {
      const mob = await repo.duplicateMob(code, mobId);
      if (!mob) throw notFound('mob not found');
      return json(200, { mob });
    }
    if (method === 'PATCH' && mobId) return await patchMob(event, repo, code, mobId);
    if (method === 'DELETE' && mobId) {
      await repo.deleteMob(code, mobId);
      return json(200, { ok: true });
    }

    throw badRequest('unsupported mob operation');
  } catch (err) {
    return errorResult(err);
  }
};
