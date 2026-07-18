// Scheduled weekly reporter (D28): reads the STATS# month partitions and emails an
// aggregate summary via SES. The stack creates this function only when a `statsEmail`
// CDK context value is provided (see infra/cdk.context.json, gitignored), and the
// address must be SES-verified in the deploy region. Env: TABLE_NAME, STATS_EMAIL,
// STATS_START_MONTH ('yyyy-mm' of the first deploy — bounds the month scan).

import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { docClient } from '../data/client';
import { buildWeeklyReport, monthsThrough, type SessionStatsRow } from '../domain/stats';

const ses = new SESv2Client({});

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

export const handler = async (): Promise<void> => {
  const now = new Date();

  const rows: SessionStatsRow[] = [];
  for (const month of monthsThrough(env('STATS_START_MONTH'), now)) {
    let cursor: Record<string, unknown> | undefined;
    do {
      const page = await docClient.send(
        new QueryCommand({
          TableName: env('TABLE_NAME'),
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': `STATS#${month}` },
          ExclusiveStartKey: cursor,
        }),
      );
      rows.push(...((page.Items ?? []) as unknown as SessionStatsRow[]));
      cursor = page.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (cursor);
  }

  const windowEnd = Math.floor(now.getTime() / 1000);
  const { subject, body } = buildWeeklyReport(rows, windowEnd - 7 * 86_400, windowEnd);

  const address = env('STATS_EMAIL');
  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: address,
      Destination: { ToAddresses: [address] },
      Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: body } } } },
    }),
  );
};
