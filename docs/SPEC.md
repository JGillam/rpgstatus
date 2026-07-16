# Wrath & Glory Session Assistant — Design Spec

**Status:** v0.1 draft (for discussion — see [Open Questions](#14-open-questions--decisions-needed))
**Last updated:** 2026-07-16

---

## 1. Problem & Context

We play *Wrath & Glory* (Warhammer 40,000 RPG) in a large, casual group — often close to
**10 players plus a GM**. Turns take a long time, so players get distracted (phones, side
chat) and lose the thread of play. Concretely:

- Players forget **whether they've already acted** this round.
- The **Wrath / Glory / Ruin** counters live as dice at one end of the table and nobody can see them.
- Only the GM (on a laptop) knows the big-picture state; the physical mini board handles
  positioning/LoS/melee, but not status.
- Healers can't easily see **who is injured and how badly**.

This app is a **shared, at-a-glance status board** — a "second screen" for the table. It does
**not** replace paper character sheets, pencils, or dice. It just makes the shared game state
visible to everyone and gives the GM a lightweight control panel.

The mental model is **Jackbox**: the GM starts a session and gets a short join code; players
join from their phones by entering the code and their name. Sessions are **ephemeral** — one
per "chapter"/sitting, lasting at most a few days, then discarded. Setup must be **fast and
low-friction** because we may run two separate sessions in a weekend.

---

## 2. Goals & Non-Goals

### Goals
- **G1 — Turn clarity.** Everyone can see the current round and who has / hasn't acted this round.
- **G2 — Shared resource visibility.** Glory (and Wrath/Ruin — see §4) visible to all in real time.
- **G3 — Party health at a glance.** Each character's Wounds/Shock and status (down/dead) visible to all, for healer planning.
- **G4 — Mob awareness.** Players see how many mobs are on the board and a *coarse* health indicator (healthy → dead), never exact HP.
- **G5 — GM control panel.** GM can edit counters, manage mobs (with exact HP), apply/remove conditions, and adjust any character.
- **G6 — Trivial setup & teardown.** Start a session in under a minute; auto-expire afterward.
- **G7 — Abuse resistance.** Random people who guess/mistype a code can't disrupt a game (GM-gated join).
- **G8 — Effectively free** to run on personal AWS, scaling to zero between sessions.

### Non-Goals (at least for v1)
- Not a virtual tabletop — no maps, mini positions, LoS, or distance measurement (the physical board stays).
- Not a character-sheet / rules engine — no dice rolling, no automatic damage/rule resolution.
- No long-term accounts, campaign history, or cross-session persistence beyond a chapter.
- No spectator/streaming features (possible later — see §7.3).

---

## 3. Roles

| Role | Device | Capabilities |
|---|---|---|
| **Game Master (GM)** | Laptop / large screen | Full control: session lifecycle, admit/kick players, counters, mobs (exact HP), conditions on anyone, edit any character, advance rounds. |
| **Player** | Phone | Read all shared state. Manage **their own** character (wounds/shock/conditions/acted flag) — see §4 & Q3. |
| **Spectator (optional/stretch)** | Any | Read-only shared view (e.g., a TV at the table). |

---

## 4. Domain Model & Terminology

> ⚠️ **Rules accuracy caveat.** Wrath & Glory has more than one edition (the 2018 release and
> the revised *Core Rules*). Exact resource behavior and the condition list differ. The model
> below is intentionally **configurable**; the specific presets need confirmation against the
> edition we play (see Q1 / Q7).

### Shared "pool" resources
- **Glory** — the shared **player** pool. Earned (e.g., Exalted Icons from Wrath dice) and spent by the party for bonuses/extra actions. **Shown to all.**
- **Ruin** — the **GM's** counterpart pool, fueling complications and enemy abilities. Likely **shown to all** (it raises tension), but could be GM-only. (Q1)
- **Wrath** — canonically a **per-character personal** resource (points spent for re-rolls, extra dice, cheating death). Some groups also track it loosely as a pool. We will model Wrath **per character** but display a party total; confirm how your table treats it. (Q1)

### Per-character state
- **Name** (set at join)
- **Max Wounds / current Wounds** — primary damage track.
- **Max Shock / current Shock** — secondary (stun/fatigue) track. Exceeding Shock typically drops a character (unconscious); exceeding Wounds pushes them toward "dying/defeated."
- **Wrath** (personal points — see above)
- **Conditions / buffs / debuffs** — tag list (see below).
- **Status flag** — one of `active`, `down` (unconscious/incapacitated), `dying`, `dead`, `stable`. "Down" is the term from the original ask.
- **Acted-this-round** — boolean for the turn tracker.

> **Starter condition presets** (configurable, confirm against edition — Q7):
> *Prone, Pinned, Bleeding, On Fire, Blinded, Restrained, Staggered, Poisoned, Frightened,
> Exhausted*, plus free-text custom tags and the status flags above. Each tag optionally carries
> a short note (e.g., "-2 Def, 2 rounds").

### Mobs (enemies/NPCs)
- **Label** (e.g., "Cultist," "Chaos Marine #2") and optional **count/grouping** (e.g., "5× Cultists"). (Q5)
- **Tier** (optional): Troops / Elite / Adversary — cosmetic grouping.
- **Exact HP** (GM-only) → mapped to a **coarse indicator shown to players**:
  `healthy` → `minor injury` → `gravely injured` → `dead` (thresholds configurable; see Q5).
- **Conditions** and an optional **unrevealed** state (players see "??" until the GM reveals it). (Q5)

---

## 5. Feature Set (MVP vs. Stretch)

### MVP (v1)
1. GM creates a session → short join **code** + private GM control URL.
2. **Lobby / admit flow:** players enter code + name → wait → GM admits (anti-abuse, G7).
3. Quick player setup: name, max Wounds, max Shock (and Wrath if per-character).
4. **Turn tracker:** current round number + per-player "acted / not yet"; GM advances round (resets flags).
5. **Shared counters:** Glory / Ruin / (Wrath total) visible to all; GM adjusts with +/−.
6. **Party roster:** every character's Wounds/Shock bars + status, visible to all.
7. **Mob list:** count on board + coarse health indicator; GM manages mobs with exact HP.
8. **GM edits:** conditions, wounds/shock, status on any character; add/remove/kill mobs.
9. Real-time sync to all screens; session **auto-expires** (TTL) and can be ended manually.

### Stretch (v2+)
- Players self-manage their own Wounds/Shock/conditions/acted flag (Q3).
- Player self-marks "down"; healer-oriented sorting/highlighting of injured allies.
- Initiative **ordering** (not just an acted checklist) + "current actor" highlight (Q6).
- Reconnect/resume across a multi-day chapter; pause/resume.
- Read-only **spectator/TV** view.
- GM "reveal mob" toggle; per-mob notes; damage log/undo.
- Simple presets: save a party roster to re-import next session.

---

## 6. UX Description (text only)

> Per your request, this is a **text description of the intended screens/flows** — not visual
> design. Layout/styling to be done later in Claude Design.

### 6.1 Landing (all users)
A single, minimal entry page: a big **"Start a session (GM)"** button and a **"Join a session"**
field (code + name). Mobile-first. No login wall.

### 6.2 GM — Create & Lobby
- Tapping **Start** generates a **4–6 character code** (e.g., `GKX7`) shown large, plus a
  **Session Settings** panel: session name/chapter, edition/preset selection (Q7), initial
  Glory/Ruin values, and toggles (e.g., "show Ruin to players").
- A **Lobby list** shows players who've entered the code, each with **Admit** / **Ignore**.
  Admitted players move into the roster. Kick control available anytime.
- Persistent header shows the code (for latecomers) and a **GM PIN reminder / recover-control** affordance (§11).

### 6.3 Player — Join & Setup
- Enter code → enter **name** → land in a **"waiting to be admitted"** state.
- Once admitted, a short setup card: **Max Wounds**, **Max Shock** (and starting **Wrath** if used).
  Sensible defaults + steppers so it's a few taps. **Done** → main player view.

### 6.4 Player — Main View (phone, read-mostly)
A single scrollable screen, top-to-bottom priority:
1. **Round & turn strip** (sticky top): "Round 3." A horizontal list of all players as chips,
   each clearly marked **✓ acted** or **• not yet**; *your* chip is emphasized. If self-manage is
   on, a big **"I've acted"** toggle for yourself.
2. **Shared counters:** Glory, (Ruin), Wrath total — large, unmissable, animate on change.
3. **Your character card:** Wounds and Shock as labeled bars with numbers; your conditions as
   removable tags (if self-manage on); a **Down** button.
4. **Party roster:** compact rows — name, Wounds/Shock mini-bars, status/conditions. Injured/
   down allies visually stand out (helps healers, G3). Read-only.
5. **Mobs on the board:** a count ("4 enemies") and a list of coarse indicators
   (green/healthy → grey/dead). No numbers.

### 6.5 GM — Main Control View (laptop, wider layout)
Everything the player sees, in a denser multi-column layout, **plus inline controls**:
- **Counters row** with +/− and set-value for Glory/Ruin/Wrath.
- **Round control:** "Next round" (confirm — resets acted flags), manual per-player acted toggles,
  optional drag-to-order initiative (stretch).
- **Party panel:** each character editable — Wounds/Shock steppers, condition picker (presets +
  custom), status dropdown (active/down/dying/dead/stable).
- **Mob panel:** add mob (label, tier, max HP, count); per-mob **exact HP** stepper with the
  derived coarse indicator shown beside it; conditions; reveal toggle; remove/kill.
- **Session panel:** code, lobby/admits, kick, end-session, TTL/expiry indicator.

### 6.6 Feedback & states
Every screen handles: connecting/reconnecting banner, "session ended/expired," "removed by GM,"
and optimistic UI that reconciles to server-authoritative state on each broadcast (§10).

---

## 7. Technical Architecture

Fully **serverless on AWS**, scales to zero, effectively free at this scale (§13).

```
                 ┌─────────────────────────────────────────────┐
   Player phones │  Static SPA (mobile-first)                   │
   GM laptop     │  hosted on S3 + CloudFront                   │
                 └───────────────┬─────────────────────────────┘
                                 │ HTTPS (REST) + WSS (WebSocket)
                 ┌───────────────▼─────────────────────────────┐
                 │  API Gateway                                 │
                 │   • HTTP API  → commands (create/join/edit)  │
                 │   • WebSocket → connect/broadcast state      │
                 └───────────────┬─────────────────────────────┘
                                 │
                 ┌───────────────▼─────────────────────────────┐
                 │  Lambda (Node/TS) — command handlers +       │
                 │  connection mgmt + broadcast fan-out         │
                 └───────────────┬─────────────────────────────┘
                                 │
                 ┌───────────────▼─────────────────────────────┐
                 │  DynamoDB single table (on-demand, TTL)      │
                 │  session / players / mobs / connections      │
                 └─────────────────────────────────────────────┘
```

### 7.1 Frontend
- **Single-page app**, mobile-first for players, responsive wider layout for the GM.
- Framework TBD (Q11) — plain TS + a light framework, or React. Static assets on **S3 behind CloudFront** (HTTPS, cheap, global-ish).
- State: keep an in-memory store hydrated by a full snapshot on connect, then patched by broadcasts.

### 7.2 Backend
- **API Gateway HTTP API** for commands (create session, join, admit, edit-anything). Idempotent,
  authoritative writes.
- **API Gateway WebSocket API** for live fan-out: on any state change, the handler writes to
  DynamoDB then pushes the new authoritative state (snapshot or delta) to every open connection
  for that session. This is the standard AWS "serverless WebSocket chat" pattern.
- **Lambda** (TypeScript) holds the domain logic + a permission check per command (role from token — §11).

### 7.3 Real-time strategy (recommendation)
- **Recommended: WebSocket API** — instant turn/counter updates, best fit for the "second screen" feel. Modest extra plumbing (store `connectionId`s, broadcast on change, clean up on disconnect).
- **Simplest alternative: HTTP polling** every ~2–3s. At ~11 users this is trivial load and removes all connection management — a fine way to ship v1 fast, upgradeable to WebSockets later.
- **Managed alternative: AWS AppSync** (GraphQL subscriptions over DynamoDB) — least fan-out code, but adds GraphQL. Reasonable if we want it "managed."
- Decision in Q2. My default: **start on WebSockets**; fall back to polling if we want the absolute minimum for a first playtest.

---

## 8. Data Model (DynamoDB, single table)

One table, on-demand billing, **TTL** attribute for auto-cleanup. Everything for a session shares
the partition key so a single query hydrates the whole board.

| Item | PK | SK | Key attributes |
|---|---|---|---|
| Session meta | `SESSION#<code>` | `META` | `state` (lobby/active/ended), `glory`, `ruin`, `round`, `settings{...}`, `gmTokenHash`, `gmPinHash`, `createdAt`, `ttl` |
| Player/character | `SESSION#<code>` | `PLAYER#<playerId>` | `name`, `maxWounds`, `wounds`, `maxShock`, `shock`, `wrath`, `conditions[]`, `status`, `actedThisRound`, `admitted`, `playerTokenHash`, `joinedAt`, `ttl` |
| Mob | `SESSION#<code>` | `MOB#<mobId>` | `label`, `tier`, `count`, `maxHp`, `hp`, `revealed`, `conditions[]`, `ttl` (coarse indicator derived from hp/maxHp) |
| Connection (if WS) | `SESSION#<code>` | `CONN#<connectionId>` | `role`, `playerId`, `connectedAt`, `ttl` |

- **Read the board:** `Query PK = SESSION#<code>` returns meta + all players + mobs (+ connections) in one call.
- **Broadcast:** query the `CONN#` items and `postToConnection` to each; delete stale connections on `GoneException`.
- **Coarse mob health** is computed server-side from `hp/maxHp` (never send exact HP to player clients).
- **TTL** (e.g., 3–7 days) auto-deletes an entire session's items — no manual teardown, matches "ephemeral."
- Server is **source of truth**; writes are last-writer-wins per field, then a full authoritative
  snapshot is broadcast so all clients converge (§10).

---

## 9. Session Lifecycle & Join Flow

1. **Create (GM).** `POST /sessions` → server generates a non-guessable-enough **code**, a **GM
   token** (returned once, stored in GM's browser), and an optional **GM PIN** the GM sets. Session
   starts in `lobby`.
2. **Join (Player).** `POST /sessions/<code>/join` with a name → creates a player in `admitted=false`
   and returns a **player token**. Player device polls/subscribes for admit status.
3. **Admit (GM).** GM sees pending players, taps **Admit** → `admitted=true`. Only admitted players
   appear in the shared roster and receive full state. **Ignore/kick** removes them.
4. **Play.** Commands flow with role checks; state broadcasts to all.
5. **End / expire.** GM ends the session, or **TTL** cleans it up automatically after the chapter.

---

## 10. Consistency & Reconnection

- All mutations go through the server, which **rebroadcasts authoritative state** — clients render
  optimistically but reconcile to the broadcast, so no client can drift.
- Counter buttons send **commands** (e.g., "glory −1") the server applies and rebroadcasts; at this
  scale last-writer-wins is acceptable.
- **Reconnect:** phones sleep and drop the socket. On reconnect the client re-presents its
  **playerToken**, is re-associated, and receives a fresh full snapshot. No lost identity.

---

## 11. Security & Abuse Prevention

Design target: **low friction, no accounts to start**, but resistant to the realistic threat —
someone mistyping/guessing a code and disrupting a game.

- **GM-gated lobby (primary defense).** Entering a code does *nothing* until the GM admits you.
  A wrong-code stranger sits in a lobby the GM simply ignores. (Directly answers G7.)
- **No accounts (recommended default).** The GM's authority lives in a **GM token** stored in the
  browser; a **GM PIN** set at creation lets the GM recover control on another device (laptop
  refresh/dies). This avoids Cognito entirely. (Q4)
- **Per-device tokens.** Each player gets a token scoped to *their* character only, so players
  can't edit each other (or the GM's controls). GM token authorizes GM-only commands.
- **Codes** are short but drawn from a large-enough space and **short-lived** (TTL), keeping the
  guess window tiny. Add **API Gateway throttling** to blunt code-guessing / create-spam.
- **Cognito is optional/later** — only worth it if we want durable GM identity across many
  campaigns or to stop anonymous session-creation abuse. Recommend deferring. (Q4)
- Minimal PII (just display names). TTL guarantees data doesn't linger.

---

## 12. Cost Estimate

At our scale (≤ ~11 concurrent users, a few short sessions per weekend, idle otherwise) this is
**effectively free** — everything scales to zero:

- **Lambda:** well within the 1M-request/month free tier.
- **DynamoDB (on-demand + TTL):** fractions of a cent per session.
- **API Gateway WebSocket:** ~$1.00 / million messages + $0.25 / million connection-minutes. A
  4-hour, 11-user session ≈ 2,640 connection-minutes and a few thousand messages → well under a cent.
- **S3 + CloudFront:** pennies/month for a tiny static site.
- **Optional custom domain:** ~$0.50/mo hosted zone + domain registration (skip with the
  CloudFront URL).

**Expected: < $1/month**, likely within free tier for hobby use.

---

## 13. Tech Choices, Repo Structure, IaC

- **IaC:** AWS **CDK (TypeScript)** recommended — pairs well with a TS Lambda/frontend and keeps
  one deployable stack. **AWS SAM** is a lighter alternative if we stay pure-Lambda. (Q11)
- **Language:** TypeScript across infra/backend/frontend for shared domain types (the same
  `Session`/`Player`/`Mob` types on both ends).
- **Suggested layout:**
  ```
  /infra       CDK app (single stack: S3+CF, API GW HTTP+WS, Lambda, DynamoDB)
  /backend     Lambda handlers + domain logic + shared types
  /frontend    SPA (player + GM views); built assets deploy to S3
  /docs        this spec, ADRs
  ```
- **CI/deploy:** a single `cdk deploy`; optionally a GitHub Action later.

---

## 14. Phased Roadmap

- **Phase 0 — Skeleton:** CDK stack (DynamoDB, HTTP API, static hosting), create/join/admit,
  hard-coded views. Prove the Jackbox flow end-to-end.
- **Phase 1 — MVP (the core pain):** round + acted tracker, shared counters, party roster with
  Wounds/Shock, mob count + coarse health, GM controls, real-time sync, TTL expiry.
- **Phase 2 — Player self-management:** players edit their own wounds/shock/conditions/acted;
  healer-oriented highlighting.
- **Phase 3 — Polish:** initiative ordering, reconnect/resume, spectator view, roster re-import,
  mob reveal/notes, undo.

---

## 15. Open Questions — Decisions Needed

These change the data model or scope, so worth settling before/early in the build:

1. **Wrath / Glory / Ruin modeling.** Canonically Glory = shared player pool, Ruin = GM pool,
   Wrath = *per-character*. How does your table actually track these? Which are visible to players
   (show Ruin or keep it GM-side)? Is Wrath per-player or a shared number for you?
2. **Real-time vs. polling.** Do you want instant updates (WebSockets, slightly more infra) or is a
   2–3s refresh (polling, simplest) fine for a first playtest?
3. **Who edits character state?** Should players update their own Wounds/Shock/conditions/acted
   flag (needs per-device tokens + self-service UI), or funnel everything through the GM in v1? You
   leaned toward self-service as a stretch goal — confirm for MVP.
4. **GM identity.** OK with the **no-account** model (GM token + PIN for device recovery), or do you
   want real accounts (Cognito) from day one? How important is seamless GM recovery if the laptop dies mid-session?
5. **Mobs.** Confirm the coarse ladder (healthy / minor / gravely injured / dead) and its thresholds.
   Track individual mobs or grouped ("5× Cultists")? Want an "unrevealed/??" state before players scout a mob?
6. **Turn model.** Is a shared **acted / not-yet checklist** enough (it directly fixes the core
   problem), or do you want strict **initiative ordering** with a "current actor"? Who advances the round — GM only, or anyone?
7. **Edition & conditions.** Which W&G edition (2018 vs. revised Core Rules)? That pins the exact
   condition/keyword list and confirms Wounds/Shock/Wrath behavior. Preset condition list, free-text
   tags, or both?
8. **Scale/among features.** Confirm ~10 players + 1 GM, a few sessions/weekend. Any need for
   multiple GMs, co-GMs, or a spectator/TV view in v1?
9. **Chapter persistence.** Fresh session every sitting (as you said), or should a session survive a
   weekend with breaks (pause/resume, re-import last party)?
10. **Preferences.** Existing AWS account + region? IaC preference (CDK vs. SAM)? Frontend framework
    preference (plain TS vs. React)? Any budget ceiling?

---

## 16. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Rules details wrong (edition differences) | Keep resources/conditions **configurable**; confirm edition (Q7) before hard-coding presets. |
| WebSocket reconnection churn (phones sleeping) | Token-based re-association + full snapshot on reconnect (§10); polling fallback (§7.3). |
| Code-guessing / session-spam abuse | GM-gated lobby, short TTL, API Gateway throttling (§11). |
| Scope creep into a full VTT | Explicit non-goals (§2); the physical board stays authoritative for positioning. |
| GM loses control (laptop dies) | GM PIN recovery (§11) — no account needed. |
| Over-engineering for 11 users | Single DynamoDB table, scale-to-zero serverless, phased roadmap starting at the core pain. |
