#!/usr/bin/env node
// CDK app entrypoint. Single stack, pinned to us-east-1 (D14: CloudFront ACM cert +
// CloudFront Functions must live in us-east-1). The account falls back to a dummy so
// `cdk synth` works fully offline (no credentials, no context lookups).
import * as cdk from 'aws-cdk-lib';
import { WgStack } from '../lib/wg-stack';

const app = new cdk.App();

new WgStack(app, 'WgAssistantStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT || '000000000000',
    region: 'us-east-1',
  },
  description:
    'Wrath & Glory Session Assistant — Phase 0 skeleton (DynamoDB, HTTP API + Lambdas, CloudFront + S3 + ACM + Route 53).',
});
