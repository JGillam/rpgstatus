import { beforeEach, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { signToken, verifyToken } from '../auth/tokens';
import type { TokenClaims } from '../domain/authz';
import type { GmSnapshot, LogEntry, MobPublicView, Player, PlayerSnapshot } from '../domain/types';
import type { MobItem as MobDbItem } from '../data/repo';
import { installDdbStore } from '../test-support/ddbStore';
import { handler as createSession } from './createSession';
import { handler as joinSession } from './joinSession';
import { handler as claim } from './claim';
import { handler as admit } from './admit';
import { handler as kick } from './kick';
import { handler as getState } from './getState';
import { handler as glory } from './glory';
import { handler as updatePlayer } from './updatePlayer';
import { sha256hex } from './http';

const store = installDdbStore();
const SECRET = () => process.env.TOKEN_SECRET!;

beforeEach(() => store.reset());

// --- fixtures -------------------------------------------------------------

function makeEvent(opts: {
  code?: string;
  playerId?: string;
  body?: unknown;
  token?: string;
  ifNoneMatch?: string;
}): APIGatewayProxyEventV2 {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.ifNoneMatch) headers['if-none-match'] = opts.ifNoneMatch;
  const pathParameters: Record<string, string> = {};
  if (opts.code) pathParameters.code = opts.code;
  if (opts.playerId) pathParameters.playerId = opts.playerId;
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: '/',
    rawQueryString: '',
    headers,
    isBase64Encoded: false,
    ...(Object.keys(pathParameters).length > 0 ? { pathParameters } : {}),
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  } as unknown as APIGatewayProxyEventV2;
}

interface Parsed {
  status: number;
  body: any;
  headers: Record<string, string | number | boolean>;
}
function parse(res: APIGatewayProxyStructuredResultV2): Parsed {
  return {
    status: res.statusCode ?? 0,
    body: typeof res.body === 'string' && res.body.length > 0 ? JSON.parse(res.body) : undefined,
    headers: (res.headers ?? {}) as Record<string, string | number | boolean>,
  };
}

function sign(claims: TokenClaims): string {
  return signToken(claims, SECRET());
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// End-to-end helpers reused across tests.
async function create(body: unknown = {}) {
  const res = parse(await createSession(makeEvent({ body })));
  expect(res.status).toBe(200);
  return res.body as { code: string; role: 'gm'; gmToken: string; state: GmSnapshot };
}
async function join(code: string, name = 'Bob') {
  const res = parse(await joinSession(makeEvent({ code, body: { name } })));
  expect(res.status).toBe(200);
  return res.body as { playerId: string; joinSecret: string };
}

// --- createSession --------------------------------------------------------

describe('POST /sessions (createSession)', () => {
  it('writes META and returns a code + verifiable GM token + GmSnapshot', async () => {
    const out = await create({ chapterName: 'The Spinward Front', glory: 2, ruin: 1, showRuin: true });
    expect(out.code).toHaveLength(5);
    expect(out.role).toBe('gm');

    const claims = verifyToken(out.gmToken, SECRET(), nowSec());
    expect(claims).toMatchObject({ code: out.code, role: 'gm' });

    // GmSnapshot returned under `state`.
    expect(out.state.session).toMatchObject({
      code: out.code,
      state: 'active',
      round: 1,
      glory: 2,
      ruin: 1,
      showRuin: true,
      settings: { chapterName: 'The Spinward Front' },
    });
    expect(out.state.players).toEqual([]);
    expect(out.state.mobs).toEqual([]);

    // META persisted with the GM token *hash* (never the token itself).
    const meta = store.get(`SESSION#${out.code}`, 'META')!;
    expect(meta.gmTokenHash).toBe(sha256hex(out.gmToken));
    expect(meta.nextPlayerIndex).toBe(0);
  });

  it('defaults a blank chapter name and rejects bad input', async () => {
    const out = await create({});
    expect(out.state.session.settings.chapterName).toBe('Untitled chapter');

    expect(parse(await createSession(makeEvent({ body: { chapterName: 'x'.repeat(49) } }))).status).toBe(400);
    expect(parse(await createSession(makeEvent({ body: { glory: -1 } }))).status).toBe(400);
    expect(parse(await createSession(makeEvent({ body: { showRuin: 'yes' } }))).status).toBe(400);
  });
});

// --- joinSession ----------------------------------------------------------

describe('POST /sessions/{code}/join (joinSession)', () => {
  it('creates a pending player and returns a one-time secret', async () => {
    const { code } = await create();
    const { playerId, joinSecret } = await join(code, 'Bob');
    expect(playerId).toBeTruthy();
    expect(joinSecret).toBeTruthy();

    const raw = store.get(`SESSION#${code}`, `PLAYER#${playerId}`)!;
    expect(raw.presence).toBe('pending');
    expect(raw.name).toBe('Bob');
    // Only the hash of the secret is stored.
    expect(raw.joinSecretHash).toBe(sha256hex(joinSecret));
    expect(raw).not.toHaveProperty('joinSecret');
  });

  it('validates the name and 404s when there is no active session', async () => {
    const { code } = await create();
    expect(parse(await joinSession(makeEvent({ code, body: { name: '' } }))).status).toBe(400);
    expect(parse(await joinSession(makeEvent({ code, body: { name: 'x'.repeat(25) } }))).status).toBe(400);

    expect(parse(await joinSession(makeEvent({ code: 'ZZZZZ', body: { name: 'Bob' } }))).status).toBe(404);

    // An ended session is not joinable.
    const meta = store.get(`SESSION#${code}`, 'META')!;
    store.seed({ ...meta, state: 'ended' });
    expect(parse(await joinSession(makeEvent({ code, body: { name: 'Bob' } }))).status).toBe(404);
  });
});

// --- claim ----------------------------------------------------------------

describe('POST /sessions/{code}/claim (claim)', () => {
  it('returns pending before admit, then an admitted token afterwards', async () => {
    const { code, gmToken } = await create();
    const { playerId, joinSecret } = await join(code);

    const pending = parse(await claim(makeEvent({ code, body: { playerId, joinSecret } })));
    expect(pending.status).toBe(200);
    expect(pending.body).toEqual({ presence: 'pending' });

    // Wrong secret is rejected.
    expect(parse(await claim(makeEvent({ code, body: { playerId, joinSecret: 'wrong' } }))).status).toBe(403);

    // GM admits, then the same claim call now yields a player token.
    expect(parse(await admit(makeEvent({ code, token: gmToken, body: { playerId } }))).status).toBe(200);

    const admitted = parse(await claim(makeEvent({ code, body: { playerId, joinSecret } })));
    expect(admitted.status).toBe(200);
    expect(admitted.body.presence).toBe('admitted');
    expect(admitted.body.index).toBe(1);

    const claims = verifyToken(admitted.body.playerToken, SECRET(), nowSec());
    expect(claims).toMatchObject({ code, role: 'player', playerIndex: 1 });
  });
});

// --- admit ----------------------------------------------------------------

describe('POST /sessions/{code}/admit (admit)', () => {
  it('is GM-only and assigns sequential indices', async () => {
    const { code, gmToken } = await create();
    const a = await join(code, 'Amy');
    const b = await join(code, 'Bob');

    // A player token cannot admit (403).
    const playerTok = sign({ code, role: 'player', playerIndex: 1, exp: nowSec() + 3600 });
    expect(parse(await admit(makeEvent({ code, token: playerTok, body: { playerId: a.playerId } }))).status).toBe(403);
    // Missing token → 401.
    expect(parse(await admit(makeEvent({ code, body: { playerId: a.playerId } }))).status).toBe(401);

    const r1 = parse(await admit(makeEvent({ code, token: gmToken, body: { playerId: a.playerId } })));
    const r2 = parse(await admit(makeEvent({ code, token: gmToken, body: { playerId: b.playerId } })));
    expect(r1.body).toEqual({ ok: true, index: 1 });
    expect(r2.body).toEqual({ ok: true, index: 2 });

    // Idempotent re-admit keeps the same index.
    const r1again = parse(await admit(makeEvent({ code, token: gmToken, body: { playerId: a.playerId } })));
    expect(r1again.body).toEqual({ ok: true, index: 1 });
  });

  it('rejects a GM token bound to a different session code (401)', async () => {
    const { code } = await create();
    const { playerId } = await join(code);
    const otherGm = sign({ code: 'OTHER', role: 'gm', exp: nowSec() + 3600 });
    expect(parse(await admit(makeEvent({ code, token: otherGm, body: { playerId } }))).status).toBe(401);
  });
});

// --- kick -----------------------------------------------------------------

describe('POST /sessions/{code}/kick (kick)', () => {
  it('ignores a pending player and removes an admitted one', async () => {
    const { code, gmToken } = await create();
    const a = await join(code, 'Amy');

    const ignored = parse(await kick(makeEvent({ code, token: gmToken, body: { playerId: a.playerId } })));
    expect(ignored.body).toEqual({ ok: true, presence: 'ignored' });

    const b = await join(code, 'Bob');
    await admit(makeEvent({ code, token: gmToken, body: { playerId: b.playerId } }));
    const removed = parse(await kick(makeEvent({ code, token: gmToken, body: { playerId: b.playerId } })));
    expect(removed.body).toEqual({ ok: true, presence: 'removed' });
  });
});

// --- getState -------------------------------------------------------------

/** Drive create → join → admit → claim and return codes + tokens + ids. */
async function admittedPlayer(createBody: unknown = {}) {
  const { code, gmToken } = await create(createBody);
  const { playerId, joinSecret } = await join(code);
  await admit(makeEvent({ code, token: gmToken, body: { playerId } }));
  const admitted = parse(await claim(makeEvent({ code, body: { playerId, joinSecret } })));
  return { code, gmToken, playerId, playerToken: admitted.body.playerToken as string };
}

function seedMob(code: string, mob: Partial<MobDbItem> & { id: string }): void {
  store.seed({
    PK: `SESSION#${code}`,
    SK: `MOB#${mob.id}`,
    id: mob.id,
    label: mob.label ?? 'Enemy',
    tier: mob.tier ?? 'Troops',
    maxHp: mob.maxHp ?? 6,
    hp: mob.hp ?? 6,
    revealed: mob.revealed ?? true,
    actedThisRound: mob.actedThisRound ?? false,
    conditions: mob.conditions ?? [],
    ttl: 9_999_999_999,
  } satisfies MobDbItem);
}

describe('GET /state/{code} (getState)', () => {
  it('returns a full GmSnapshot (exact HP, hidden mobs, acted flags) for a GM token', async () => {
    const { code, gmToken } = await admittedPlayer({ ruin: 5, showRuin: false });
    seedMob(code, { id: 'm1', hp: 3, maxHp: 6, revealed: true, actedThisRound: true });
    seedMob(code, { id: 'm2', hp: 6, maxHp: 6, revealed: false });

    const res = parse(await getState(makeEvent({ code, token: gmToken })));
    expect(res.status).toBe(200);
    const snap = res.body as GmSnapshot;
    expect(snap.session.ruin).toBe(5); // GM sees Ruin regardless of showRuin
    expect(snap.players).toHaveLength(1);
    expect(snap.mobs).toHaveLength(2); // hidden mob included for GM
    const m1 = snap.mobs.find((m) => m.id === 'm1')!;
    expect(m1.hp).toBe(3);
    expect(m1.maxHp).toBe(6);
    expect(m1.actedThisRound).toBe(true);
  });

  it('projects a PlayerSnapshot: no exact HP, hidden mobs dropped, Ruin null when hidden', async () => {
    const { code, playerId, playerToken } = await admittedPlayer({ ruin: 5, showRuin: false });
    seedMob(code, { id: 'm1', hp: 3, maxHp: 6, revealed: true }); // 50% → 'minor'
    seedMob(code, { id: 'm2', hp: 6, maxHp: 6, revealed: false }); // hidden

    const res = parse(await getState(makeEvent({ code, token: playerToken })));
    expect(res.status).toBe(200);
    const snap = res.body as PlayerSnapshot;

    expect(snap.youId).toBe(playerId);
    expect(snap.session.ruin).toBeNull(); // showRuin=false → hidden from players

    // Only the revealed mob, coarsened, with NO exact-HP / acted leak.
    expect(snap.mobs).toHaveLength(1);
    const mob = snap.mobs[0] as MobPublicView & Record<string, unknown>;
    expect(mob.id).toBe('m1');
    expect(mob.coarse).toBe('minor');
    expect(mob).not.toHaveProperty('hp');
    expect(mob).not.toHaveProperty('maxHp');
    expect(mob).not.toHaveProperty('actedThisRound');
    expect(mob).not.toHaveProperty('revealed');
  });

  it('rejects invalid, expired, and wrong-code tokens with 401; 404 when the session is gone', async () => {
    const { code, gmToken } = await admittedPlayer();

    // Garbage token.
    expect(parse(await getState(makeEvent({ code, token: 'not.a.token' }))).status).toBe(401);
    // Missing token.
    expect(parse(await getState(makeEvent({ code }))).status).toBe(401);
    // Expired token.
    const expired = sign({ code, role: 'gm', exp: 1 });
    expect(parse(await getState(makeEvent({ code, token: expired }))).status).toBe(401);
    // Valid token, but for a session that doesn't exist → 404.
    const ghost = sign({ code: 'GHOST', role: 'gm', exp: nowSec() + 3600 });
    expect(parse(await getState(makeEvent({ code: 'GHOST', token: ghost }))).status).toBe(404);

    // Sanity: the good token still works.
    expect(parse(await getState(makeEvent({ code, token: gmToken }))).status).toBe(200);
  });

  it('honors If-None-Match with a weak ETag → 304', async () => {
    const { code, gmToken } = await admittedPlayer();
    const first = parse(await getState(makeEvent({ code, token: gmToken })));
    expect(first.status).toBe(200);
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^W\//);

    const second = parse(await getState(makeEvent({ code, token: gmToken, ifNoneMatch: etag })));
    expect(second.status).toBe(304);
    expect(second.body).toBeUndefined();
  });
});

// --- glory ----------------------------------------------------------------

describe('POST /sessions/{code}/glory (glory)', () => {
  it('pushes/pulls, floors at 0, and logs each change attributed to the actor', async () => {
    const { code, gmToken, playerToken } = await admittedPlayer();

    // Player pushes +1 → 1, logged under the player's index (1).
    const p1 = parse(await glory(makeEvent({ code, token: playerToken, body: { delta: 1 } })));
    expect(p1.status).toBe(200);
    expect(p1.body).toEqual({ glory: 1 });

    // GM pushes +1 → 2, logged under index 0.
    const g1 = parse(await glory(makeEvent({ code, token: gmToken, body: { delta: 1 } })));
    expect(g1.body).toEqual({ glory: 2 });

    // GM pulls −1 twice → 1 → 0.
    expect(parse(await glory(makeEvent({ code, token: gmToken, body: { delta: -1 } }))).body).toEqual({ glory: 1 });
    expect(parse(await glory(makeEvent({ code, token: gmToken, body: { delta: -1 } }))).body).toEqual({ glory: 0 });

    // A further pull cannot go negative — floored, value unchanged at 0 (D16).
    expect(parse(await glory(makeEvent({ code, token: gmToken, body: { delta: -1 } }))).body).toEqual({ glory: 0 });

    // Log attribution: player push = index 1, GM push = index 0; both type 'G'.
    const log = store.get(`SESSION#${code}`, 'LOG')!.e as LogEntry[];
    expect(log[0]).toEqual([1, 1, 'G', expect.any(Number)]);
    expect(log[1]).toEqual([0, 1, 'G', expect.any(Number)]);
    expect(log[2]).toEqual([0, -1, 'G', expect.any(Number)]);
  });

  it('rejects a missing/invalid token with 401 and a non-integer delta with 400', async () => {
    const { code, gmToken } = await admittedPlayer();
    expect(parse(await glory(makeEvent({ code, body: { delta: 1 } }))).status).toBe(401);
    expect(parse(await glory(makeEvent({ code, token: 'not.a.token', body: { delta: 1 } }))).status).toBe(401);
    expect(parse(await glory(makeEvent({ code, token: gmToken, body: { delta: 1.5 } }))).status).toBe(400);
  });
});

// --- updatePlayer ---------------------------------------------------------

describe('PATCH /sessions/{code}/players/{playerId} (updatePlayer)', () => {
  it('lets the owner edit their own character (clamps wounds/shock/wrath, status, acted, conditions)', async () => {
    const { code, playerId, playerToken } = await admittedPlayer();

    // Defaults: maxWounds 12, maxShock 6, wrath 0..6. Over-max inputs clamp to the max.
    const res = parse(
      await updatePlayer(
        makeEvent({
          code,
          playerId,
          token: playerToken,
          body: {
            wounds: 100,
            shock: 100,
            wrath: 99,
            status: 'down',
            actedThisRound: true,
            conditions: [{ id: 'bleeding', rank: 2 }, { id: 'prone' }],
          },
        }),
      ),
    );
    expect(res.status).toBe(200);
    const p = res.body.player as Player;
    expect(p.wounds).toBe(12); // clamped to maxWounds
    expect(p.shock).toBe(6); // clamped to maxShock
    expect(p.wrath).toBe(6); // clamped to 6
    expect(p.status).toBe('down');
    expect(p.actedThisRound).toBe(true);
    expect(p.conditions).toEqual([{ id: 'bleeding', rank: 2 }, { id: 'prone' }]);

    // A negative current clamps to the 0 floor.
    const low = parse(await updatePlayer(makeEvent({ code, playerId, token: playerToken, body: { wounds: -5 } })));
    expect((low.body.player as Player).wounds).toBe(0);
  });

  it("rejects a different player's token with 403 but lets the GM edit anyone", async () => {
    const { code, gmToken, playerId } = await admittedPlayer();

    // A token for a *different* player (index 2) may not edit player index 1.
    const otherTok = sign({ code, role: 'player', playerIndex: 2, exp: nowSec() + 3600 });
    expect(parse(await updatePlayer(makeEvent({ code, playerId, token: otherTok, body: { wounds: 5 } }))).status).toBe(403);

    // The GM can edit any character.
    const gmRes = parse(await updatePlayer(makeEvent({ code, playerId, token: gmToken, body: { status: 'dead' } })));
    expect(gmRes.status).toBe(200);
    expect((gmRes.body.player as Player).status).toBe('dead');
  });

  it('401s an invalid/missing token and 404s an unknown player', async () => {
    const { code, gmToken, playerId } = await admittedPlayer();
    expect(parse(await updatePlayer(makeEvent({ code, playerId, body: { wounds: 1 } }))).status).toBe(401);
    expect(parse(await updatePlayer(makeEvent({ code, playerId, token: 'garbage', body: { wounds: 1 } }))).status).toBe(401);
    expect(parse(await updatePlayer(makeEvent({ code, playerId: 'no-such-id', token: gmToken, body: { wounds: 1 } }))).status).toBe(404);
  });
});
