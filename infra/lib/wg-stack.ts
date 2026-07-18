// Wrath & Glory Session Assistant — single CDK stack (SPEC §8, §12, §14; D14, D25).
// DynamoDB single table + Phase-0 Lambdas + HTTP API + CloudFront/S3/ACM/Route 53,
// with an apex 302 redirect. Region is fixed to us-east-1 by the app (bin/app.ts).
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';

// Domain + DNS (D25). The hosted zone pre-exists in the target AWS account.
// Self-hosters: replace these constants with your own domain + hosted zone.
const DOMAIN = 'rpgstatus.com';
const APP_HOST = `wrathandglory.${DOMAIN}`;
const APP_RECORD_NAME = 'wrathandglory';
const HOSTED_ZONE_ID = 'Z00083172DL6778MI6UCU';

// Phase-0 backend handlers (each exports `handler`, reads TABLE_NAME + TOKEN_SECRET).
const HANDLERS_DIR = path.join(__dirname, '..', '..', 'backend', 'src', 'handlers');
const DEPS_LOCK = path.join(__dirname, '..', '..', 'package-lock.json');

export class WgStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1. DynamoDB single table (§9). One partition per session; TTL 3d (D14).
    const table = new dynamodb.Table(this, 'Table', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      // Feeds the D28 stats harvest: TTL reaps stream the deleted item's final image.
      stream: dynamodb.StreamViewType.OLD_IMAGE,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    // Hard spend ceiling on on-demand throughput (cost armor, §12). Legit usage for a
    // handful of concurrent tables is tens of RRU/s; the cap only bounds worst-case
    // abuse if the API throttles are ever bypassed. Escape hatch: the L2 Table
    // construct predates OnDemandThroughput, but CloudFormation applies it in place.
    const cfnTable = table.node.defaultChild as dynamodb.CfnTable;
    cfnTable.addPropertyOverride('OnDemandThroughput', {
      MaxReadRequestUnits: 100,
      MaxWriteRequestUnits: 50,
    });

    // 2. HMAC token secret (§12/D13); >= 32 chars.
    const tokenSecret = new secretsmanager.Secret(this, 'TokenSecret', {
      description: 'HMAC secret for signing W&G GM/player tokens (SPEC §12/D13).',
      generateSecretString: {
        passwordLength: 48,
        excludePunctuation: true,
      },
    });
    // unsafeUnwrap() emits a {{resolve:secretsmanager:...}} dynamic reference that
    // CloudFormation resolves at deploy time INTO the Lambda env config (visible in
    // the Lambda console). Acceptable here — it avoids a runtime Secrets Manager
    // fetch, and handlers read it straight from process.env.TOKEN_SECRET.
    const tokenSecretValue = tokenSecret.secretValue.unsafeUnwrap();

    // 3. One NodejsFunction per handler. Backend is ESM (type:module); esbuild
    //    bundles locally at synth (esbuild installed → no Docker).
    const commonBundling: nodejs.BundlingOptions = {
      format: nodejs.OutputFormat.ESM,
      target: 'node20',
      // AWS SDK v3 ships in the Node 20 runtime → keep it external (small bundle).
      externalModules: ['@aws-sdk/*'],
      // Defensive CJS-interop shim for ESM output: define require/__dirname/__filename
      // so any bundled dependency that reaches for them resolves at runtime. Our own
      // code is pure ESM, so in practice this stays unused — belt and suspenders.
      banner:
        "import{createRequire as _cr}from'module';const require=_cr(import.meta.url);" +
        "import{fileURLToPath as _ffp}from'url';import{dirname as _dn}from'path';" +
        'const __filename=_ffp(import.meta.url);const __dirname=_dn(__filename);',
    };

    const makeHandler = (name: string, environment?: Record<string, string>): nodejs.NodejsFunction =>
      new nodejs.NodejsFunction(this, `Fn-${name}`, {
        runtime: lambda.Runtime.NODEJS_20_X,
        entry: path.join(HANDLERS_DIR, `${name}.ts`),
        handler: 'handler',
        depsLockFilePath: DEPS_LOCK,
        timeout: cdk.Duration.seconds(10),
        memorySize: 256,
        // Two-week retention via the LogRetention custom resource — the log groups
        // already exist (auto-created at first invoke), so an explicit logGroup
        // resource would collide; the custom resource patches retention in place.
        logRetention: logs.RetentionDays.TWO_WEEKS,
        environment: environment ?? {
          TABLE_NAME: table.tableName,
          TOKEN_SECRET: tokenSecretValue,
        },
        bundling: commonBundling,
      });

    const createSessionFn = makeHandler('createSession');
    const joinSessionFn = makeHandler('joinSession');
    const claimFn = makeHandler('claim');
    const admitFn = makeHandler('admit');
    const kickFn = makeHandler('kick');
    const getStateFn = makeHandler('getState');
    const gloryFn = makeHandler('glory');
    const updatePlayerFn = makeHandler('updatePlayer');
    // Phase-1 GM mutation handlers.
    const ruinFn = makeHandler('ruin');
    const nextRoundFn = makeHandler('nextRound');
    const updateSessionFn = makeHandler('updateSession');
    const endSessionFn = makeHandler('endSession');
    const mobsFn = makeHandler('mobs');

    // getState only reads the table; the mutating handlers read + write.
    table.grantReadData(getStateFn);
    for (const fn of [
      createSessionFn,
      joinSessionFn,
      claimFn,
      admitFn,
      kickFn,
      gloryFn,
      updatePlayerFn,
      ruinFn,
      nextRoundFn,
      updateSessionFn,
      endSessionFn,
      mobsFn,
    ]) {
      table.grantReadWriteData(fn);
    }

    // 3b. Anonymous usage stats (D28). TTL-reaped META items stream to a harvest fn
    // that writes permanent STATS# rows (counts only — no names/codes) back into the
    // same table. The event filter narrows invokes to exactly "the DynamoDB TTL
    // service REMOVEd a session META item" — live-session writes never invoke it.
    const statsHarvestFn = makeHandler('statsHarvest', { TABLE_NAME: table.tableName });
    table.grantWriteData(statsHarvestFn);
    statsHarvestFn.addEventSource(
      new DynamoEventSource(table, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 25,
        retryAttempts: 2,
        filters: [
          lambda.FilterCriteria.filter({
            eventName: lambda.FilterRule.isEqual('REMOVE'),
            userIdentity: {
              type: lambda.FilterRule.isEqual('Service'),
              principalId: lambda.FilterRule.isEqual('dynamodb.amazonaws.com'),
            },
            dynamodb: { Keys: { SK: { S: lambda.FilterRule.isEqual('META') } } },
          }),
        ],
      }),
    );

    // Weekly email report — created only when a statsEmail is provided, so no personal
    // address lives in the repo: put `{ "statsEmail": "you@example.com" }` in the
    // gitignored infra/cdk.context.json (or pass `-c statsEmail=...`). The address must
    // be SES-verified in this region; without it, stats still accumulate, no email.
    const statsEmail = this.node.tryGetContext('statsEmail') as string | undefined;
    if (statsEmail) {
      const statsReportFn = makeHandler('statsReport', {
        TABLE_NAME: table.tableName,
        STATS_EMAIL: statsEmail,
        STATS_START_MONTH: '2026-07',
      });
      table.grantReadData(statsReportFn);
      statsReportFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ses:SendEmail'],
          resources: [`arn:aws:ses:${this.region}:${this.account}:identity/${statsEmail}`],
        }),
      );
      // Mondays 13:00 UTC ≈ 9am US-Eastern in summer (8am in winter).
      new events.Rule(this, 'StatsWeeklyRule', {
        description: 'Weekly anonymous usage-stats email (D28)',
        schedule: events.Schedule.cron({ minute: '0', hour: '13', weekDay: 'MON' }),
        targets: [new eventTargets.LambdaFunction(statsReportFn)],
      });
    }

    // 4. HTTP API (D12). The auto-created `$default` stage serves routes at the root
    //    path (no stage segment), so CloudFront can forward paths verbatim.
    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: 'wg-http-api',
      corsPreflight: {
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PATCH,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['Authorization', 'Content-Type'],
        allowOrigins: ['*'],
      },
    });

    const addRoute = (
      routePath: string,
      method: apigwv2.HttpMethod,
      fn: nodejs.NodejsFunction,
      integrationId: string,
    ): apigwv2.HttpRoute[] =>
      httpApi.addRoutes({
        path: routePath,
        methods: [method],
        integration: new integrations.HttpLambdaIntegration(integrationId, fn),
      });
    const routes: apigwv2.HttpRoute[] = [
      ...addRoute('/sessions', apigwv2.HttpMethod.POST, createSessionFn, 'IntCreateSession'),
      ...addRoute('/sessions/{code}/join', apigwv2.HttpMethod.POST, joinSessionFn, 'IntJoin'),
      ...addRoute('/sessions/{code}/claim', apigwv2.HttpMethod.POST, claimFn, 'IntClaim'),
      ...addRoute('/sessions/{code}/admit', apigwv2.HttpMethod.POST, admitFn, 'IntAdmit'),
      ...addRoute('/sessions/{code}/kick', apigwv2.HttpMethod.POST, kickFn, 'IntKick'),
      ...addRoute('/sessions/{code}/glory', apigwv2.HttpMethod.POST, gloryFn, 'IntGlory'),
      ...addRoute(
        '/sessions/{code}/players/{playerId}',
        apigwv2.HttpMethod.PATCH,
        updatePlayerFn,
        'IntUpdatePlayer',
      ),
      ...addRoute('/state/{code}', apigwv2.HttpMethod.GET, getStateFn, 'IntGetState'),
      // Phase-1 GM mutations.
      ...addRoute('/sessions/{code}/ruin', apigwv2.HttpMethod.POST, ruinFn, 'IntRuin'),
      ...addRoute('/sessions/{code}/round/next', apigwv2.HttpMethod.POST, nextRoundFn, 'IntNextRound'),
      ...addRoute('/sessions/{code}', apigwv2.HttpMethod.PATCH, updateSessionFn, 'IntUpdateSession'),
      ...addRoute('/sessions/{code}/end', apigwv2.HttpMethod.POST, endSessionFn, 'IntEndSession'),
      // Four mob routes → the SAME mobs fn (each integration gets a unique id).
      ...addRoute('/sessions/{code}/mobs', apigwv2.HttpMethod.POST, mobsFn, 'IntMobsCreate'),
      ...addRoute('/sessions/{code}/mobs/{mobId}', apigwv2.HttpMethod.PATCH, mobsFn, 'IntMobsPatch'),
      ...addRoute('/sessions/{code}/mobs/{mobId}', apigwv2.HttpMethod.DELETE, mobsFn, 'IntMobsDelete'),
      ...addRoute(
        '/sessions/{code}/mobs/{mobId}/duplicate',
        apigwv2.HttpMethod.POST,
        mobsFn,
        'IntMobsDuplicate',
      ),
    ];

    // Throttling (D12): a default cap, plus stricter caps on the uncacheable, abusable
    // create/join routes. Route settings aren't exposed on the L2, so use the CfnStage
    // escape hatch on the auto-created `$default` stage.
    const cfnStage = httpApi.defaultStage!.node.defaultChild as apigwv2.CfnStage;
    // addPropertyOverride writes the template verbatim — use PascalCase keys. The L1 typed
    // properties (defaultRouteSettings/routeSettings) leaked camelCase field names, which
    // CloudFormation rejects on AWS::ApiGatewayV2::Stage RouteSettings.
    // Limits are per route, so the stage-wide worst case is roughly
    // default × route count — sized as a billing ceiling (~$2-3 per million requests
    // through API GW + Lambda + DDB + logs), not as capacity. /state is the only hot
    // legit path: one 10-player table polls at ~5 rps.
    cfnStage.addPropertyOverride('DefaultRouteSettings', {
      ThrottlingRateLimit: 10,
      ThrottlingBurstLimit: 20,
    });
    cfnStage.addPropertyOverride('RouteSettings', {
      'POST /sessions': { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 5 },
      'POST /sessions/{code}/join': { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 5 },
      'GET /state/{code}': { ThrottlingRateLimit: 25, ThrottlingBurstLimit: 50 },
    });
    // RouteSettings validate against existing route keys, so the stage must be created AFTER
    // the routes — otherwise "Unable to find Route by key POST /sessions".
    for (const route of routes) {
      cfnStage.node.addDependency(route);
    }

    // 6. Route 53 hosted zone — explicit attributes, so no context lookup at synth.
    const zone = route53.PublicHostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: HOSTED_ZONE_ID,
      zoneName: DOMAIN,
    });

    // 5. One ACM cert (this stack is us-east-1, correct for CloudFront), reused by both
    //    distributions. DNS validation is wired to the zone (waits at deploy time).
    const cert = new acm.Certificate(this, 'Cert', {
      domainName: DOMAIN,
      subjectAlternativeNames: [`*.${DOMAIN}`],
      validation: acm.CertificateValidation.fromDns(zone),
    });

    // 7. Private S3 bucket + CloudFront for the SPA.
    const appBucket = new s3.Bucket(this, 'AppBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // API origin hostname derived from the HttpApi endpoint by stripping `https://`.
    // Using the $default stage means this base host serves routes at the root path, so
    // no stage-prefix rewrite is needed on the CloudFront behaviors below.
    const apiDomainName = cdk.Fn.select(1, cdk.Fn.split('https://', httpApi.apiEndpoint));
    const apiOrigin = new origins.HttpOrigin(apiDomainName, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    });
    // TODO(phase2): origin lock — only CloudFront should reach the API (a secret header
    // added here + verified in Lambda, or WAF). Not implemented in Phase 0.
    const apiBehavior: cloudfront.BehaviorOptions = {
      origin: apiOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL, // POST mutations + GET reads
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      // Forward Authorization + all query strings to the origin; drop only Host.
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    };

    const appDistribution = new cloudfront.Distribution(this, 'AppDistribution', {
      comment: 'W&G app (wrathandglory.rpgstatus.com)',
      defaultRootObject: 'index.html',
      domainNames: [APP_HOST],
      certificate: cert,
      defaultBehavior: {
        // Private bucket reached via Origin Access Control (OAC).
        origin: origins.S3BucketOrigin.withOriginAccessControl(appBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      additionalBehaviors: {
        // TODO(phase2): add a CloudFront Function (viewer-request) edge token check
        // (HMAC/exp, no backend call) + code-keyed short-TTL caching for '/state/*'.
        '/sessions*': apiBehavior,
        '/state/*': apiBehavior,
      },
      // SPA fallback: client-side routes resolve to index.html.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
    });

    // 8. App DNS alias (A + AAAA): wrathandglory.rpgstatus.com → app distribution.
    const appAliasTarget = route53.RecordTarget.fromAlias(
      new targets.CloudFrontTarget(appDistribution),
    );
    new route53.ARecord(this, 'AppAliasA', {
      zone,
      recordName: APP_RECORD_NAME,
      target: appAliasTarget,
    });
    new route53.AaaaRecord(this, 'AppAliasAaaa', {
      zone,
      recordName: APP_RECORD_NAME,
      target: appAliasTarget,
    });

    // 8b. Ship the built SPA to the bucket + invalidate CloudFront on each deploy.
    //     Requires frontend/dist to exist first: `npm --workspace @wg/frontend run build`.
    new s3deploy.BucketDeployment(this, 'AppSpaDeployment', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', '..', 'frontend', 'dist'))],
      destinationBucket: appBucket,
      distribution: appDistribution,
      distributionPaths: ['/*'],
      prune: true,
      logRetention: logs.RetentionDays.TWO_WEEKS,
    });

    // 9. Apex 302 redirect (D25: temporary → 302, NOT a 301, so NOT HttpsRedirect).
    //    A CloudFront Function at viewer-request returns the redirect before the origin
    //    is ever reached.
    const apexRedirectFn = new cloudfront.Function(this, 'ApexRedirectFn', {
      comment: 'Apex 302 redirect to the app host',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        `function handler(event) {
  var request = event.request;
  return {
    statusCode: 302,
    statusDescription: 'Found',
    headers: {
      location: { value: 'https://${APP_HOST}' + request.uri }
    }
  };
}`,
      ),
    });

    const apexDistribution = new cloudfront.Distribution(this, 'ApexRedirectDistribution', {
      comment: 'Apex 302 redirect (rpgstatus.com -> app host)',
      domainNames: [DOMAIN],
      certificate: cert,
      defaultBehavior: {
        // Throwaway origin — never reached; the viewer-request function returns first.
        origin: new origins.HttpOrigin(APP_HOST),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations: [
          {
            function: apexRedirectFn,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
    });

    // Apex DNS alias (A + AAAA): rpgstatus.com (no recordName) → redirect distribution.
    const apexAliasTarget = route53.RecordTarget.fromAlias(
      new targets.CloudFrontTarget(apexDistribution),
    );
    new route53.ARecord(this, 'ApexAliasA', { zone, target: apexAliasTarget });
    new route53.AaaaRecord(this, 'ApexAliasAaaa', { zone, target: apexAliasTarget });

    // 10. Outputs.
    new cdk.CfnOutput(this, 'AppUrl', { value: `https://${APP_HOST}` });
    new cdk.CfnOutput(this, 'AppDistributionDomain', {
      value: appDistribution.distributionDomainName,
    });
    new cdk.CfnOutput(this, 'ApexRedirectDistributionDomain', {
      value: apexDistribution.distributionDomainName,
    });
    new cdk.CfnOutput(this, 'HttpApiEndpoint', { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'BucketName', { value: appBucket.bucketName });
  }
}
