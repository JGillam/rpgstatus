# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately via GitHub: **Security → Report a vulnerability** on this
repository. Responses are best-effort — this is an unpaid hobby project, and there is no bug
bounty.

## Scope

- The code in this repository, and the reference deployment at `*.rpgstatus.com`.
- Please **do not** run volumetric or denial-of-service style testing against the hosted
  instance — it's a shared hobby deployment with deliberate spend ceilings, and you'd mostly be
  testing AWS's ability to return 429s. DoS-resistance findings are welcome as code review
  instead.
- There is deliberately little at stake data-wise: no accounts, no personal data beyond display
  names, and everything is TTL-deleted within 72 hours. The interesting surfaces are session
  token handling (`backend/src/auth/`), authorization scoping (`backend/src/handlers/`), and the
  CloudFront / API Gateway boundary (`infra/lib/wg-stack.ts`).

## Supported versions

The `main` branch and whatever is live at wrathandglory.rpgstatus.com (they track each other).
