// DynamoDB Stream consumer (D28): when the TTL service reaps a session's META item,
// capture an anonymous stats row before the data is gone for good. The event source
// mapping (infra) is filtered to REMOVE of SK='META' performed by the TTL principal,
// so every record here means "a session just fully expired". Writes one PERMANENT row
// into the same table — counts only (players/rounds/state), no join code, no display
// names, and no ttl attribute. The SK reuses the stream eventID, so a retried batch
// overwrites the same row instead of double-counting.

import type { DynamoDBStreamEvent } from 'aws-lambda';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../data/client';
import { statsMonth } from '../domain/stats';

const tableName = (): string => process.env.TABLE_NAME!;

export const handler = async (event: DynamoDBStreamEvent): Promise<void> => {
  for (const record of event.Records) {
    try {
      const img = record.dynamodb?.OldImage;
      const createdAt = Number(img?.createdAt?.N);
      if (!img || !Number.isFinite(createdAt)) continue; // defensive — the filter should preclude this
      await docClient.send(
        new PutCommand({
          TableName: tableName(),
          Item: {
            PK: `STATS#${statsMonth(createdAt)}`,
            SK: `S#${createdAt}#${(record.eventID ?? 'unknown').slice(0, 12)}`,
            created: createdAt,
            players: Number(img.nextPlayerIndex?.N ?? '0'),
            rounds: Number(img.round?.N ?? '0'),
            state: img.state?.S ?? 'unknown',
            harvestedAt: Math.floor(Date.now() / 1000),
          },
        }),
      );
    } catch (err) {
      // Stats are best-effort: skip the record rather than poisoning the whole batch.
      console.error('statsHarvest: skipped record', record.eventID, err);
    }
  }
};
