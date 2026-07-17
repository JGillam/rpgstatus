// Vitest global setup — the data/handler layers read these lazily at call time.
process.env.TABLE_NAME ??= 'wg-test-table';
process.env.TOKEN_SECRET ??= 'test-hmac-secret';
