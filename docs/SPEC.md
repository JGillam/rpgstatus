# Wrath & Glory Session Assistant — Design Spec

**Status:** v0.2 draft (decisions from round 1 folded in — see [Decisions Log](#2-decisions-log))
**Last updated:** 2026-07-16

---

## 1. Problem & Context

We play *Wrath & Glory* (Warhammer 40,000 RPG) in a large, casual group — often close to
**10 players plus a GM**. Turns take a long time, so players get distracted (phones, side chat)
and lose the thread of play. Concretely:

- Players forget **whether they've already acted** this round.
- The **Glory / Ruin / Wrath** counters live as dice at one end of the table and nobody can see them.
- Only the GM (on a laptop) knows the big-picture state; the physical mini board handles
  positioning/LoS/melee, but not status.
- Healers can't easily see **who is injured and how badly**.

This app is a **shared, at-a-glance status board** — a "second screen" for the table. It does
**not** replace paper character sheets, pencils, or dice. It makes shared game state visible to
everyone and gives the GM a lightweight control panel.

The mental model is **Jackbox**: the GM starts a session and gets a short join code; players join
from their phones with the code + their name. Sessions are **ephemeral** — one per
"chapter"/sitting, lasting at most a few days, then auto-expired. Setup must be **fast** because we
may run two sessions in a weekend. The app may also be made **public**, so other groups could run
their own concurrent sessions on the same deployment.

---

## 2. Decisions Log

Resolved 2026-07-16 (round 1). These supersede earlier open questions.

| # | Decision |
|---|---|
| D1 | **Resources:** **Ruin** = single global counter, **visibility toggleable by the GM**. **Glory** = shared party counter, **always visible** (kept because "can't see the Glory counter" was part of the original pain — see Q-A). **Wrath** = **per character** (lives alongside that character's Wounds/Shock). |
| D2 | **Sync = polling** (cheap), not WebSockets. App may go **public/multi-tenant**, so cost-per-session and light abuse control matter. |
| D3 | **Players self-manage** their own character (wounds/shock/conditions/Wrath/acted flag). **GM can see everything and override** anyone (e.g., a player who stepped away). |
| D4 | **GM resilience via browser localStorage** — GM token persists across a browser restart/reboot; state is server-authoritative so nothing is lost on reconnect. **Switching to a different laptop is out of scope** (no account/PIN needed). |
| D5 | **Mobs:** tracked **individually**; support an **unrevealed** state (added hidden, GM clicks to reveal) so a GM can pre-build a fight; **duplicate button** to quickly clone a mob (fill in "Cultist," click to make 4). |
| D6 | **Turn model = shared acted/not-yet checklist only.** No initiative engine (the Core rules let the group decide order and use Glory to seize initiative). **GM manages turns**; advancing the round resets the checklist. |
| D7 | **Edition = Core Rules.** Condition presets target Core (exact list still to be confirmed — Q-B). |
| D8 | **Stack:** AWS **CDK**; frontend **React + Vite + shadcn/ui + Tailwind**; **DynamoDB** (not an S3 state file — see §9.3); optimize for very low cost; no custom domain yet. |

---

## 3. Goals & Non-Goals

### Goals
- **G1 — Turn clarity.** Current round + who has / hasn't acted, visible to all.
- **G2 — Shared resource visibility.** Glory (always) and Ruin (GM-toggleable) visible in near-real-time; per-character Wrath visible on each character.
- **G3 — Party health at a glance.** Each character's Wounds/Shock + status (down/dead), for healer planning.
- **G4 — Mob awareness.** Players see mob count + a *coarse* health indicator (healthy → dead); never exact HP; unrevealed mobs hidden until the GM reveals them.
- **G5 — Player self-service + GM override.** Players edit their own character; GM edits anything.
- **G6 — Trivial setup & teardown.** Start in under a minute; auto-expire (TTL) after the chapter.
- **G7 — Abuse resistance.** GM-gated join; safe to run as a public site.
- **G8 — Very cheap & scale-to-zero**, including under public multi-tenant use.

### Non-Goals (v1)
- Not a virtual tabletop — no maps, positions, LoS, distance (physical board stays authoritative).
- Not a rules/character-sheet engine — no dice, no automatic damage/rules resolution, no initiative engine.
- No long-term accounts or cross-chapter history.
- No streaming/spectator features (possible later — §7).

---

## 4. Roles

| Role | Device | Capabilities |
|---|---|---|
| **Game Master (GM)** | Laptop / large screen | Full control: session lifecycle, admit/kick, Ruin (+ toggle its visibility), Glory, mobs (exact HP, reveal, duplicate), conditions on anyone, **override any character**, advance round. |
| **Player** | Phone | Read all shared state; manage **their own** character (Wounds/Shock/Wrath/conditions/acted). |
| **Spectator (stretch)** | TV/any | Read-only shared view. |

---

## 5. Domain Model & Terminology

> ⚠️ **Rules note.** We target the **Core Rules** edition. The resource model is settled (D1); the
> exact **condition list** still needs confirming against the book (Q-B). Everything below is
> configurable so presets can be corrected without code changes.

### Shared resources
- **Glory** — shared **party** pool. **Always visible.** Adjustable by the GM (and optionally players, since it's their pool). Atomic +/−.
- **Ruin** — global **GM** pool. **Visibility toggled by the GM** (hidden by default, or shown to raise tension). GM-managed. Atomic +/−.

### Per-character state
- **Name** (set at join)
- **Max Wounds / current Wounds** — primary damage track.
- **Max Shock / current Shock** — secondary (stun/fatigue) track.
- **Wrath** (personal points — re-rolls, extra dice, cheating death). Shown on the character.
- **Conditions / buffs / debuffs** — tag list (presets + free-text, each with an optional note).
- **Status flag** — `active` | `down` | `dying` | `dead` | `stable`.
- **Acted-this-round** — boolean for the turn checklist.

> **Starter condition presets** (Core-targeted, confirm — Q-B): *Prone, Pinned, Bleeding, On Fire,
> Blinded, Restrained, Staggered, Poisoned, Frightened, Exhausted*, plus custom tags and the status
> flags above.

### Mobs (enemies/NPCs)
- **Label** (e.g., "Cultist 1").
- **Revealed flag** — mobs may be added **unrevealed** (players don't see them) and **revealed** on a GM click. Lets the GM pre-build a fight.
- **Exact HP** (GM-only) → mapped to a **coarse indicator for players**:
  `healthy` → `minor injury` → `gravely injured` → `dead` (thresholds configurable — Q-C).
- **Tier** (optional cosmetic grouping: Troops / Elite / Adversary).
- **Conditions** (optional).
- **Duplicate action** — clone a mob's stats to add several of the same quickly.

---

## 6. Feature Set (MVP vs. Stretch)

### MVP (v1)
1. GM creates a session → short join **code** + GM control view (GM token saved in localStorage).
2. **Lobby / admit:** players enter code + name → wait → GM admits (anti-abuse, G7). Kick anytime.
3. Quick player setup: name, max Wounds, max Shock, starting Wrath.
4. **Turn checklist:** round number + per-player acted/not-yet; GM "Next round" resets it.
5. **Shared counters:** Glory (always) + Ruin (GM-toggleable) with GM +/−; Wrath per character.
6. **Party roster:** everyone's Wounds/Shock + status/conditions, visible to all.
7. **Player self-service:** each player edits their own Wounds/Shock/Wrath/conditions/acted/Down.
8. **GM override:** GM can edit any character's fields.
9. **Mobs:** add (with unrevealed default + reveal button), exact HP (GM) → coarse indicator
   (players), duplicate, conditions, kill/remove.
10. **Polling sync**; **TTL** auto-expiry; manual end-session.

### Stretch (v2+)
- Healer-oriented sorting/highlighting of injured allies; injured-ally alerts.
- Read-only **spectator / TV** view.
- Save/re-import a party roster between chapters.
- Per-mob notes; damage log + undo.
- "Reveal all" / group mob controls; mob templates.

*(Explicitly not planned: initiative ordering engine — D6.)*

---

## 7. UX Description (text only)

> Per request, this is a **text description of screens/flows**, not visual design. Layout/styling
> to be produced later in Claude Design against React + shadcn/ui + Tailwind.

### 7.1 Landing (all)
Minimal, mobile-first: **"Start a session (GM)"** and a **"Join"** field (code + name). No login wall.

### 7.2 GM — Create & Lobby
- **Start** → generates a **4–6 char code** shown large + a **Session Settings** panel: chapter
  name, condition preset set, initial Glory/Ruin, and a **"Show Ruin to players"** toggle.
- **Lobby list** of players who entered the code, each with **Admit** / **Ignore**; admitted
  players move into the roster; **Kick** available anytime.
- Header persists the code (for latecomers). GM authority is remembered on this browser (localStorage).

### 7.3 Player — Join & Setup
- Enter code → name → **"waiting to be admitted."**
- On admit: a short card — **Max Wounds**, **Max Shock**, **starting Wrath** (defaults + steppers) → **Done**.

### 7.4 Player — Main View (phone)
Single scrollable screen, priority top-to-bottom:
1. **Round & turn strip** (sticky): "Round 3." Player chips marked **✓ acted** / **• not yet**;
   *your* chip emphasized; a big **"I've acted"** toggle for yourself.
2. **Shared counters:** Glory (always), Ruin (if GM enabled) — large, animate on change.
3. **Your character card:** Wounds & Shock bars + numbers with steppers; **Wrath** stepper; your
   conditions as add/removable tags; a **Down** button. (You edit *your own* card.)
4. **Party roster:** compact read-only rows — name, Wounds/Shock mini-bars, status/conditions;
   injured/down allies stand out (G3).
5. **Mobs on the board:** count + list of coarse indicators (healthy → dead). Unrevealed mobs are
   not shown. No numbers.

### 7.5 GM — Main Control View (laptop, wider)
Everything players see, denser, **plus inline controls**:
- **Counters row:** Glory and Ruin with +/− and set-value; Ruin visibility toggle.
- **Round control:** "Next round" (confirm — resets acted flags); manual per-player acted toggles.
- **Party panel:** each character editable (Wounds/Shock/Wrath steppers, condition picker, status
  dropdown) — GM override.
- **Mob panel:** add mob (label, tier, max HP) — defaults to **unrevealed**; **Reveal** button;
  **Duplicate** button; exact-HP stepper with the derived coarse indicator beside it; conditions;
  kill/remove.
- **Session panel:** code, lobby/admits, kick, end-session, expiry indicator.

### 7.6 Feedback & states
Every screen handles: reconnecting banner, "session ended/expired," "removed by GM," and optimistic
edits that reconcile to server-authoritative state on the next poll (§11).

---

## 8. Technical Architecture

Fully **serverless on AWS**, scale-to-zero, cheap under public multi-tenant use (§13). **Polling**,
with the read path **cached at the CloudFront edge** so poll volume barely touches the backend.

```
                 ┌──────────────────────────────────────────────┐
   Player phones │  Static SPA (React + Vite + shadcn/Tailwind)  │
   GM laptop     │  on S3, served via CloudFront                 │
                 └───────────────┬──────────────────────────────┘
                                 │ HTTPS
                 ┌───────────────▼──────────────────────────────┐
                 │  CloudFront                                   │
                 │   • /            → S3 static assets           │
                 │   • GET /state/<code> → cached ~1–2s (polls)  │
                 │   • POST /… (mutations) → not cached          │
                 └───────────────┬──────────────────────────────┘
                                 │ (cache miss / mutations only)
                 ┌───────────────▼──────────────────────────────┐
                 │  Lambda (Node/TS): read + mutation handlers,  │
                 │  role checks, coarse-HP projection            │
                 └───────────────┬──────────────────────────────┘
                                 │
                 ┌───────────────▼──────────────────────────────┐
                 │  DynamoDB single table (on-demand, TTL)       │
                 │  session / players / mobs                     │
                 └──────────────────────────────────────────────┘
```

- **Read path:** clients `GET /state/<code>` every ~2–3s. CloudFront caches per-code for ~1–2s, so
  N clients collapse to ~1 origin read per cache window per session — most polls never invoke Lambda
  or DynamoDB. Clients may also send `If-None-Match` for cheap 304s.
- **Write path:** `POST /…` mutations skip the cache → Lambda → DynamoDB (atomic updates). Staleness
  is bounded by cacheTTL + poll interval (a few seconds) — fine for a status board.
- **Origin:** API Gateway HTTP API *or* a Lambda Function URL behind CloudFront (Function URL avoids
  per-request API-GW charges; decide at build time — Q-D).
- **Coarse mob HP** is projected **server-side**; exact HP never leaves the backend for player tokens.

---

## 9. Data Model (DynamoDB single table)

One table, on-demand, **TTL** for auto-cleanup. All of a session's items share the partition key, so
one `Query` hydrates the whole board.

| Item | PK | SK | Key attributes |
|---|---|---|---|
| Session meta | `SESSION#<code>` | `META` | `state` (lobby/active/ended), `glory`, `ruin`, `showRuin` (bool), `round`, `settings{…}`, `gmTokenHash`, `createdAt`, `ttl` |
| Player/character | `SESSION#<code>` | `PLAYER#<id>` | `name`, `maxWounds`, `wounds`, `maxShock`, `shock`, `wrath`, `conditions[]`, `status`, `actedThisRound`, `admitted`, `playerTokenHash`, `joinedAt`, `ttl` |
| Mob | `SESSION#<code>` | `MOB#<id>` | `label`, `tier`, `maxHp`, `hp`, `revealed` (bool), `conditions[]`, `ttl` |

### 9.1 Access patterns
- **Hydrate board:** `Query PK = SESSION#<code>` → meta + players + mobs in one call. The read
  handler projects mob HP to a coarse label and strips unrevealed mobs / exact HP for player tokens.
- **Mutations are per-item and mostly atomic:**
  - Counters: `UpdateItem … ADD glory :d` / `ADD ruin :d` (atomic increment — no read-modify-write).
  - A player edits only their `PLAYER#<id>` item; the GM may edit any item (override).
  - Mob duplicate = `PutItem` of a new `MOB#<newId>` copied from the source.
  - "Next round" = update each player's `actedThisRound=false` (small batch) + bump `round`.

### 9.2 Lifecycle & cleanup
- **TTL** (e.g., 3–7 days) auto-deletes an entire session's items — no teardown, matches
  "ephemeral," satisfies retention with zero ops.
- Server is **source of truth**; concurrent edits to *different* items never conflict, and the shared
  counters use atomic increments — so "several people editing at once" is a non-issue.

### 9.3 Why DynamoDB, not an S3 state file *(answering the round-1 question)*

The instinct was S3 (one JSON file per session) to drive DB reads to ~zero. It actually optimizes the
wrong axis and adds a correctness hazard:

- **Reads are the volume here (polling), and DynamoDB reads are *cheaper* than S3 GETs**, not more
  expensive. Small-item DynamoDB read ≈ **$0.125/M** vs S3 GET ≈ **$0.40/M** (~3× cheaper). Writes:
  DynamoDB ≈ **$1.25/M** vs S3 PUT ≈ **$5.00/M** (~4× cheaper). DynamoDB wins on both.
- **A single S3 file is a lost-update trap.** Two simultaneous edits both GET→modify→PUT and the last
  PUT overwrites the first (whole-file rewrite). S3 conditional writes (`If-Match` on ETag) can guard
  it, but then you must **retry on conflict** → *more* PUTs under contention, and you've serialized
  every edit through one object. DynamoDB per-item + atomic counters sidesteps all of this.
- **The real read-cost lever is edge caching, not the datastore.** A ~2s CloudFront TTL collapses a
  4-hour, 11-player session from ~52,800 origin reads to ~7,200 **regardless of client count** — so
  the datastore barely gets touched either way. That optimization is independent of S3 vs DynamoDB.

**Ballpark (order-of-magnitude, verify before relying):**

| Per 4h, 11-player session | reads | writes | total |
|---|---|---|---|
| DynamoDB (per-item)   | ~$0.0066 | ~$0.0004 | **~$0.007** |
| S3 (whole-file)       | ~$0.0211 | ~$0.0015 | **~$0.023** |
| DynamoDB + 2s edge cache | ~$0.0009 | ~$0.0004 | **~$0.001** |

Both are fractions of a cent, so at 11 users it genuinely doesn't matter for *cost* — but DynamoDB is
cheaper *and* avoids the concurrency headache, so it's the better default. Keep S3 only for hosting
the static React app.

---

## 10. Session Lifecycle & Join Flow

1. **Create (GM).** `POST /sessions` → server generates a **code** + a **GM token** (stored in the
   GM browser's localStorage). Session starts `lobby`.
2. **Join (Player).** `POST /sessions/<code>/join` {name} → player created `admitted=false`, returns
   a **player token** (localStorage). Player device polls for admit status.
3. **Admit (GM).** GM taps **Admit** → `admitted=true`; player enters the shared roster.
   **Ignore/Kick** removes them.
4. **Play.** Mutations flow with role checks; everyone polls the (cached) state.
5. **End / expire.** GM ends manually, or **TTL** auto-cleans after the chapter.

---

## 11. Consistency, Polling & GM Resilience

- **Server-authoritative.** All mutations go through Lambda→DynamoDB; clients render optimistically
  but reconcile to the next polled snapshot, so no client drifts. Bounded staleness = cacheTTL + poll
  ≈ a few seconds (acceptable for a status board).
- **Atomic shared counters** (`ADD glory/ruin`) mean simultaneous +/− never clobber.
- **GM reboot / lost connection (D4).** The GM token lives in **localStorage** and survives a browser
  restart; game state lives server-side, so on reconnect the GM re-reads current state and loses
  nothing. Different-laptop recovery is intentionally out of scope (no account/PIN).
- **Player reconnect.** Phones sleep; on return the client re-presents its player token and re-reads
  state — identity preserved.

---

## 12. Security & Abuse Prevention

Target: **low friction, no accounts**, safe enough to run **publicly**.

- **GM-gated lobby (primary defense).** Entering a code does nothing until the GM admits you; a
  wrong-code stranger sits in a list the GM ignores (G7).
- **Per-device tokens.** Player token authorizes edits to **its own character only** (+ shared Glory,
  optionally); GM token authorizes GM-only actions and overrides. Tokens in localStorage.
- **Codes** are short but drawn from a large-enough space and **short-lived** (TTL) → tiny guess
  window. Uniqueness enforced across active sessions (matters once public).
- **Public multi-tenant hardening:** **throttle/rate-limit session creation and joins** (per-IP) to
  blunt create-spam and code-guessing; consider a lightweight challenge on *create* only if abuse
  appears. Coarse-HP projection + unrevealed filtering happen **server-side**, so player clients never
  receive hidden data.
- **No accounts / no Cognito** (D4) — revisit only if durable GM identity or stronger anti-abuse is
  needed. Minimal data (display names only); TTL guarantees nothing lingers.

---

## 13. Cost

Scale-to-zero serverless; **fractions of a cent per session** (§9.3), and cheap even public:

- **Lambda:** within the 1M-req/mo free tier; edge caching means most polls don't even invoke it.
- **DynamoDB (on-demand + TTL):** ~$0.001–0.007 per session (§9.3), within/near free tier.
- **CloudFront + S3:** pennies/month for a tiny static site + cached JSON.
- **~100 concurrent public sessions, edge-cached:** still on the order of **cents** in reads+writes.
- **Custom domain:** none yet (use the CloudFront URL); ~$0.50/mo hosted zone + registration if added later.

**Expected: within/near free tier for hobby use; low single-digit dollars/month even with modest public traffic.**

---

## 14. Tech Stack, Repo Structure, IaC

- **IaC:** AWS **CDK (TypeScript)** — single stack (S3+CloudFront, Lambda, DynamoDB, HTTP API or
  Function URL).
- **Frontend:** **React + Vite + shadcn/ui + Tailwind**, mobile-first (player) + responsive wider
  (GM). Built assets → S3 → CloudFront.
- **Backend:** **TypeScript Lambda**; share domain types (`Session`/`Player`/`Mob`) with the frontend.
- **Suggested layout:**
  ```
  /infra       CDK app (single stack)
  /backend     Lambda handlers + domain logic + shared types
  /frontend    React/Vite SPA (player + GM views)
  /docs        this spec, ADRs
  ```
- **Deploy:** `cdk deploy`; optional GitHub Action later.

---

## 15. Phased Roadmap

- **Phase 0 — Skeleton:** CDK stack (DynamoDB, Lambda, CloudFront+S3), create/join/admit, cached
  `GET /state`. Prove the Jackbox flow end-to-end.
- **Phase 1 — MVP:** turn checklist, Glory/Ruin (+toggle) counters, party roster (Wounds/Shock/Wrath),
  **player self-service + GM override**, mobs (unrevealed/reveal/duplicate + coarse HP), polling, TTL.
- **Phase 2 — Public-ready:** rate-limiting on create/join, code uniqueness, minor landing page,
  reconnect polish.
- **Phase 3 — Nice-to-haves:** healer highlighting, spectator/TV view, roster re-import, mob
  notes/undo.

---

## 16. Remaining Open Questions

Most are resolved (§2). Still worth confirming:

- **Q-A — Glory inclusion.** I kept **Glory as a shared, always-visible counter** (it was in your
  original "can't see the counters" pain), alongside Ruin (global, toggleable) and per-character
  Wrath. Confirm you want Glory shown, and say **who may change Glory** — GM only, or players too?
- **Q-B — Core condition list.** Give me the exact **Core Rules** condition names you use and I'll set
  the presets precisely (free-text custom stays available regardless).
- **Q-C — Coarse-HP thresholds.** Confirm the ladder and cutoffs (e.g., healthy ≥75%, minor 40–74%,
  gravely 1–39%, dead 0%).
- **Q-D — Origin choice.** Lambda **Function URL** behind CloudFront (cheapest) vs **API Gateway HTTP
  API** (routing/throttling built in). Default: Function URL for cost; fine either way.
- **Q-E — Region & retention.** Preferred AWS region, and desired TTL length (3 days? 7?).

---

## 17. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Core condition/keyword details wrong | Configurable presets + custom tags; confirm list (Q-B). |
| Public abuse (create-spam, code-guessing) | GM-gated lobby, short TTL, per-IP throttling, server-side data filtering (§12). |
| Lost updates from concurrent edits | Per-item writes + atomic counters in DynamoDB (§9.3) — structurally avoided. |
| Polling staleness feels laggy | ~2s cache + ~2–3s poll ≈ a few seconds; tune TTL; WebSockets remain a later option if needed. |
| Scope creep into a full VTT | Explicit non-goals (§3); physical board stays authoritative. |
| GM loses connection/reboots | localStorage token + server-authoritative state (§11); different-laptop out of scope by choice. |
