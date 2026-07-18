# rpgstatus

Session status boards for tabletop RPG tables. One game so far: **Wrath & Glory**
(the Warhammer 40,000 roleplaying game) — live at **https://wrathandglory.rpgstatus.com**.

> **Unofficial fan project.** Not affiliated with, endorsed by, or licensed by Games Workshop or
> Cubicle 7. *Wrath & Glory* and *Warhammer 40,000* are trademarks of their respective owners.

## What it is

A shared, at-a-glance "second screen" for big, casual tables (think ~10 players plus a GM). The
physical board keeps handling positioning and the paper sheets stay authoritative — this just makes
shared state visible so nobody loses the plot between turns. The mental model is Jackbox: the GM
starts a session and reads out a 5-character join code; players join from their phones. No accounts,
nothing to install.

- **Turn checklist** — current round, who has and hasn't acted, one-tap "I've acted".
- **Shared counters** — party Glory (anyone can push/pull; every change is attributed in an
  activity log), GM-controlled Ruin with a visibility toggle, per-character Wrath.
- **Party health** — everyone's Wounds/Shock at a glance, so the healer can triage.
- **Enemies** — the GM tracks exact mob HP; players see only a coarse healthy → dead indicator,
  and unrevealed mobs stay hidden until the GM reveals them.
- **Condition chips** with plain-language tooltip summaries, so nobody digs through the book
  mid-round.
- **Ephemeral by design** — sessions auto-delete within 72 hours (DynamoDB TTL). The exportable
  activity log is the only thing that leaves.

The full design spec — problem statement, decision log, data model, security posture — lives in
[docs/SPEC.md](docs/SPEC.md).

## How it's built

An npm-workspaces monorepo, serverless on AWS (us-east-1), scale-to-zero — fractions of a cent per
session:

| Workspace | What's in it |
|---|---|
| `frontend/` | React + Vite + Tailwind SPA: phone-first player screen + a denser GM console |
| `backend/` | TypeScript Lambda handlers + pure domain logic; HMAC-signed GM/player tokens; server-side projection (player clients never receive exact mob HP or hidden mobs) |
| `infra/` | Single CDK stack: CloudFront + S3 (SPA), throttled API Gateway HTTP API, Lambda, DynamoDB single table with TTL |
| `data/` | `conditions.json` — condition names + original-wording tooltip summaries |

Sync is deliberately low-tech polling (GM every 5s, players every 8s) with CloudFront edge caching
collapsing any number of clients into ~one origin read per cache window — SPEC §8 and §11 explain
why.

## Self-hosting

You can run your own copy in your own AWS account:

1. Prereqs: Node ≥ 20, an AWS account with CDK bootstrapped, and a Route 53 hosted zone for a
   domain you control.
2. Edit the constants at the top of [infra/lib/wg-stack.ts](infra/lib/wg-stack.ts) (`DOMAIN`,
   `APP_HOST`, `APP_RECORD_NAME`, `HOSTED_ZONE_ID`) to point at your zone. Yes, they're hardcoded
   for the reference deployment — PRs making them context/env-driven are welcome.
3. `npm ci`
4. `npm run build --workspace @wg/frontend` — the stack ships `frontend/dist` to S3.
5. `cd infra && npx cdk deploy` with credentials for your account. The region must be
   **us-east-1** (CloudFront ACM certificates and CloudFront Functions require it).
6. *(Optional)* Weekly usage-stats email: put `{ "statsEmail": "you@example.com" }` in
   `infra/cdk.context.json` (gitignored) — the address must be verified in SES in the deploy
   region. Without it, anonymous per-session stats still accumulate in the table and no email
   is sent.

The deploy output prints your API endpoint and CloudFront domains.

## Local development

```sh
npm ci
npm test              # backend unit tests (vitest)
npm run typecheck     # all workspaces
```

There is no local backend emulator — the frontend dev server proxies `/sessions*` and `/state/*`
to a deployed stack. Create `frontend/.env.local` with your stack's API origin:

```sh
VITE_PROXY_TARGET=https://<api-id>.execute-api.<region>.amazonaws.com
```

then run `npm run dev --workspace @wg/frontend`.

## Feedback & contributing

This is a hobby fan tool, shared in case it's useful to other tables. Bug reports, rules nitpicks,
and feature ideas are welcome as GitHub issues; small PRs too — see
[CONTRIBUTING.md](CONTRIBUTING.md). It comes with no support promises.

Most of this codebase was written with [Claude Code](https://claude.com/claude-code), reviewed and
directed by a human. If that bothers you, the nice thing about open source is that you can read
every line.

## Privacy

No accounts, no analytics, no personal data beyond the display names players type in — and every
session is deleted automatically within 72 hours. The deployment keeps anonymous, aggregate usage
counts (sessions, players per session, rounds) harvested as sessions expire — never names or
join codes.

## License

The code is licensed **AGPL-3.0-only** — see [LICENSE](LICENSE). If you host a modified version,
the AGPL requires you to offer its users the source. Contributions are accepted under Apache-2.0
(see [CONTRIBUTING.md](CONTRIBUTING.md)).

The license covers **this code only**. It grants no rights to *Wrath & Glory* or *Warhammer
40,000* game content, which remains the property of Games Workshop / Cubicle 7; the app's few
rules references (condition names and short original-wording effect summaries) are included as
unofficial fan reference.
