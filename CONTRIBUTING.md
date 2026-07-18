# Contributing

Thanks for taking an interest! rpgstatus is a hobby fan project — feedback and contributions are
genuinely welcome, with expectations set accordingly: best-effort responses, no roadmap promises.

## The easiest ways to help

- **Bug reports and rules nitpicks** — open an issue. For rules-content issues (say, a condition
  summary that's wrong for the Core Rules), describe what's wrong in your own words; please don't
  paste rulebook text into the issue.
- **Feature ideas** — open an issue first. The tool is deliberately small (see the non-goals in
  [docs/SPEC.md](docs/SPEC.md) §3); proposals that turn it into a virtual tabletop or a rules
  engine will likely be declined.

## Pull requests

- For anything bigger than a small fix, open an issue first so we agree on the shape.
- Dev setup is in the README under "Local development". Before opening a PR, run
  `npm run typecheck && npm test`.
- Behavior changes should update [docs/SPEC.md](docs/SPEC.md) too — it's the project's decision
  log and source of truth.
- Game-content ground rule: **no rulebook text, stat blocks, lore, or art.** Mechanics references
  in original wording only, and no more of them than the tool actually needs.

## Licensing of contributions

The project is distributed under **AGPL-3.0-only**. Inbound is different from outbound: **by
submitting a contribution you agree to license it under the Apache License 2.0**. That lets the
maintainer distribute your work as part of the AGPL-licensed whole and — if it ever comes to that —
relicense the project, including commercially, without having to track down every past contributor.
You keep the copyright to your contribution.

If you're not comfortable with that, completely fair — open an issue describing the change
instead, and it can be implemented independently.
