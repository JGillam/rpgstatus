// D28 usage stats: harvest (stream consumer) + weekly reporter, against the in-memory
// store. SESv2 is mocked separately (aws-sdk-client-mock on the client class).

import { beforeEach, describe, expect, it } from 'vitest';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { mockClient } from 'aws-sdk-client-mock';
import { installDdbStore } from '../test-support/ddbStore';
import { handler as statsHarvest } from './statsHarvest';
import { handler as statsReport } from './statsReport';
import { statsMonth } from '../domain/stats';

const store = installDdbStore();
const sesMock = mockClient(SESv2Client);

beforeEach(() => {
  store.reset();
  sesMock.reset();
  sesMock.on(SendEmailCommand).resolves({});
});

// --- fixtures -------------------------------------------------------------

const NOW_SEC = Math.floor(Date.now() / 1000);

/** A stream REMOVE record shaped like a TTL reap of a session META item. */
function ttlRemoveRecord(opts: {
  eventID?: string;
  createdAt?: number;
  nextPlayerIndex?: number;
  round?: number;
  state?: string;
}): DynamoDBStreamEvent['Records'][number] {
  const createdAt = opts.createdAt ?? NOW_SEC - 4 * 86_400;
  return {
    eventID: opts.eventID ?? 'evt-0001',
    eventName: 'REMOVE',
    userIdentity: { type: 'Service', principalId: 'dynamodb.amazonaws.com' },
    dynamodb: {
      Keys: { PK: { S: 'SESSION#ABC23' }, SK: { S: 'META' } },
      OldImage: {
        PK: { S: 'SESSION#ABC23' },
        SK: { S: 'META' },
        code: { S: 'ABC23' },
        state: { S: opts.state ?? 'ended' },
        round: { N: String(opts.round ?? 6) },
        nextPlayerIndex: { N: String(opts.nextPlayerIndex ?? 7) },
        createdAt: { N: String(createdAt) },
        ttl: { N: String(createdAt + 3 * 86_400) },
      },
    },
  } as DynamoDBStreamEvent['Records'][number];
}

describe('statsHarvest', () => {
  it('writes a permanent STATS row (counts only, no code, no ttl) from the reaped META image', async () => {
    const createdAt = NOW_SEC - 4 * 86_400;
    await statsHarvest({ Records: [ttlRemoveRecord({ createdAt })] } as DynamoDBStreamEvent);

    const month = statsMonth(createdAt);
    const rows = store.all().filter((i) => (i.PK as string).startsWith('STATS#'));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.PK).toBe(`STATS#${month}`);
    expect(row.SK).toBe(`S#${createdAt}#evt-0001`);
    expect(row).toMatchObject({ created: createdAt, players: 7, rounds: 6, state: 'ended' });
    expect(row.harvestedAt).toBeGreaterThanOrEqual(NOW_SEC);
    // Anonymous + permanent: no join code, no names, and no ttl attribute.
    expect(row.code).toBeUndefined();
    expect(row.ttl).toBeUndefined();
  });

  it('is idempotent across a retried batch (same eventID → same SK, one row)', async () => {
    const event = { Records: [ttlRemoveRecord({ eventID: 'evt-retry' })] } as DynamoDBStreamEvent;
    await statsHarvest(event);
    await statsHarvest(event);
    expect(store.all().filter((i) => (i.PK as string).startsWith('STATS#'))).toHaveLength(1);
  });

  it('skips malformed records without failing the batch', async () => {
    const good = ttlRemoveRecord({ eventID: 'evt-good' });
    const noImage = { eventID: 'evt-bad-1', eventName: 'REMOVE' } as DynamoDBStreamEvent['Records'][number];
    const badCreated = ttlRemoveRecord({ eventID: 'evt-bad-2' });
    delete (badCreated.dynamodb!.OldImage as Record<string, unknown>).createdAt;

    await statsHarvest({ Records: [noImage, badCreated, good] } as DynamoDBStreamEvent);

    const rows = store.all().filter((i) => (i.PK as string).startsWith('STATS#'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.SK).toContain('evt-good');
  });
});

describe('statsReport', () => {
  it('emails a weekly summary over harvestedAt with lifetime totals', async () => {
    const inWindowCreated = NOW_SEC - 5 * 86_400;
    // Two sessions harvested this week, one long before (lifetime only).
    store.seed({
      PK: `STATS#${statsMonth(inWindowCreated)}`,
      SK: `S#${inWindowCreated}#a`,
      created: inWindowCreated,
      players: 4,
      rounds: 5,
      state: 'ended',
      harvestedAt: NOW_SEC - 2 * 86_400,
    });
    store.seed({
      PK: `STATS#${statsMonth(inWindowCreated)}`,
      SK: `S#${inWindowCreated}#b`,
      created: inWindowCreated,
      players: 9,
      rounds: 11,
      state: 'active',
      harvestedAt: NOW_SEC - 86_400,
    });
    const oldCreated = NOW_SEC - 30 * 86_400;
    store.seed({
      PK: `STATS#${statsMonth(oldCreated)}`,
      SK: `S#${oldCreated}#c`,
      created: oldCreated,
      players: 2,
      rounds: 3,
      state: 'ended',
      harvestedAt: oldCreated + 4 * 86_400,
    });

    process.env.STATS_EMAIL = 'stats@example.test';
    process.env.STATS_START_MONTH = statsMonth(oldCreated);
    await statsReport();

    const calls = sesMock.commandCalls(SendEmailCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    expect(input.FromEmailAddress).toBe('stats@example.test');
    expect(input.Destination?.ToAddresses).toEqual(['stats@example.test']);
    const subject = input.Content?.Simple?.Subject?.Data ?? '';
    const body = input.Content?.Simple?.Body?.Text?.Data ?? '';
    expect(subject).toContain('2 sessions');
    expect(body).toContain('Sessions this week: 2');
    expect(body).toContain('min 4 · median 6.5 · max 9');
    expect(body).toContain('Lifetime: 3 sessions · 15 player-seats');
  });

  it('still sends a zero-session heartbeat', async () => {
    process.env.STATS_EMAIL = 'stats@example.test';
    process.env.STATS_START_MONTH = statsMonth(NOW_SEC);
    await statsReport();

    const calls = sesMock.commandCalls(SendEmailCommand);
    expect(calls).toHaveLength(1);
    const body = calls[0]!.args[0].input.Content?.Simple?.Body?.Text?.Data ?? '';
    expect(body).toContain('Sessions this week: 0');
    expect(body).toContain('Lifetime: 0 sessions');
  });
});
