// Shared DynamoDBDocumentClient singleton for the Lambda handlers. Kept out of
// repo.ts so the Repo class stays construction-injectable (and easy to unit test).
// aws-sdk-client-mock's mockClient(DynamoDBDocumentClient) intercepts this instance.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const base = new DynamoDBClient({});

export const docClient = DynamoDBDocumentClient.from(base, {
  marshallOptions: {
    // Drop undefined attributes (e.g. an optional chapterName / unset playerTokenHash).
    removeUndefinedValues: true,
  },
});
