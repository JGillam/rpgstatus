# Wrath & Glory Session Assistant — Design Spec

**Status:** v0.8 — rounds 1–7 folded in; rounds 3–4 = Claude Design review, round 5 = domain & hosting, round 6 = post-start max correction, round 7 = poll cadence.
**Last updated:** 2026-07-18

---

## 1. Problem & Context

We play *Wrath & Glory* (Warhammer 40,000 RPG) in a large, casual group — often close to
**10 players plus a GM**. Turns take a long time, so players get distracted (phones, side chat) and
lose the thread of play. Concretely:

- Players forget **whether they've already acted** this round.
- The **Glory / Ruin / Wrath** counters live as dice at one end of the table and nobody can see them.
- Only the GM (on a laptop) knows the big-picture state; the physical mini board handles
  positioning/LoS/melee, but not status.
- Healers can't easily see **who is injured and how badly**.

This app is a **shared, at-a-glance status board** — a "second screen" for the table. It does **not**
replace paper character sheets, pencils, or dice. It makes shared game state visible to everyone and
gives the GM a lightweight control panel.

The mental model is **Jackbox**: the GM starts a session and gets a short join code; players join
from their phones with the code + their name. Sessions are **ephemeral** — one per "chapter"/sitting,
**≤ 48h in practice, auto-expired at 3 days**. Setup must be **fast**. The app may be made
**public**, so other groups could run concurrent sessions on the same deployment — which raises the
bar on **abuse resistance**.

---

## 2. Decisions Log

### Round 1 (2026-07-16)
| # | Decision |
|---|---|
| D1 | **Resources:** **Ruin** = single global counter, **GM-toggleable visibility**. **Glory** = shared party counter, **always visible**. **Wrath** = **per character** (with that character's Wounds/Shock). |
| D2 | **Sync = polling** (cheap), not WebSockets. App may go **public/multi-tenant**. |
| D3 | **Players self-manage** their own character; **GM sees all and can override** anyone. |
| D4 | **GM resilience via browser localStorage**; state is server-authoritative. **Different-laptop recovery is out of scope** (no account/PIN). |
| D5 | **Mobs** tracked **individually**; **unrevealed** state + GM **reveal**; **duplicate** button to clone. |
| D6 | **Turn model = shared acted/not-yet checklist only** (no initiative engine); **GM manages turns**. |
| D7 | **Edition = Core Rules.** |
| D8 | **Stack:** AWS **CDK**; **React + Vite + shadcn/ui + Tailwind**; **DynamoDB** (not an S3 state file — §9.3); very low cost; no custom domain yet. |

### Round 2 (2026-07-16)
| # | Decision |
|---|---|
| D9 | **Glory is player-adjustable.** Any player can **push** (+1, e.g. after banking a 6 on the Wrath die) or **pull** (−1) Glory; the GM can too. The app does **not** enforce the "spend by consensus" social rule — it just records who did what. |
| D10 | **Activity log.** Record Glory (and Ruin) pushes/pulls as compact, attributed entries (who, delta, type, timestamp). ~hundreds/day max. Included in state; **GM can export/download** it (client-side, since it's already in the browser). |
| D11 | **Conditions** use the **14 Core conditions** from the GM's verified reference, now captured in **`/data/conditions.json`** (name + stacking flag + paraphrased tooltip summary). Frontend shows **tooltips** instead of reaching for the book. |
| D12 | **Origin = API Gateway HTTP API** (revised from "Function URL") — for its **built-in throttling**, which is the cleanest lock-down against abuse. Reads are still **edge-cached**, so its per-request cost is negligible. Function URL remains a fallback **only if locked behind CloudFront** (§12). |
| D13 | **Auth = simple signed, expiring tokens** (GM + per-player), validated on mutations (and ideally at the edge for reads). Sessions ≤ 48h, so short token lifetimes are fine. |
| D14 | **Region = us-east-1** (required for CloudFront ACM cert + CloudFront Functions/WAF). **TTL = 3 days.** |

### Round 3 (2026-07-17) — Claude Design review feedback
| # | Decision |
|---|---|
| D15 | **Mobs join the turn checklist.** Each mob gets an `actedThisRound` flag (GM-only — never sent to players); **"Next round" resets players' *and* mobs'** acted flags. |
| D16 | **Counter bounds.** Glory and Ruin **floor at 0** (decrements are conditional, not blind atomic ADDs); **Wrath clamps to 0–6**. |
| D17 | **Condition `note` + custom free-text conditions deferred to v2.** MVP ships exactly the 14 preset conditions with ranks (matches the designed picker). |
| D18 | **Mob names are GM-editable at any time.** GMs often name a mob descriptively ("Grotesk Blob", "Mob 1") and rename it once the party identifies the creature. Add-mob becomes a small dialog (name, tier, max HP, count 1–8, starts-hidden) and mob names support inline rename. |
| D19 | **`conditions.json` gains a `category`** (`damage` / `affliction` / `impairment`) so condition-chip theming is data-driven instead of name lists hardcoded in the frontend. |
| D20 | **Join code stays 5 chars for MVP** (unambiguous alphabet — no 0/O/1/I); revisit length when the Phase 2 edge token check lands (the code is then not the read capability). |

### Round 4 (2026-07-17) — Entry/Join, GM Setup & GM Console v2 designs
| # | Decision |
|---|---|
| D21 | **Player presence lifecycle.** Replace `admitted:boolean` with **`presence`** = `pending` \| `admitted` \| `ignored` \| `removed`. **Ignore/Kick soft-mark** (tombstone, cleaned by TTL) instead of hard-deleting, so a returning client can tell *waiting* → *not admitted (ignored)* vs *removed by GM*. Roster = `presence==='admitted'`; lobby = `presence==='pending'`. |
| D22 | **Sessions are live from creation.** Drop the `lobby` session state — admission is **continuous** via the lobby panel. **`SessionState = active \| ended`** (persisted); **`expired`** is client-derived when the session item is gone (TTL). |
| D23 | **Settings + validation limits.** `settings.chapterName?` (≤48; blank → "Untitled chapter"). Central limits: display name 1–24 (required); max Wounds 1–40; max Shock 1–20; Wrath 0–6; Glory/Ruin ≥0; mob maxHp ≥1; add-mob count 1–8; join code 5× `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`. |
| D24 | **Batch add-mob.** Add-mob takes a **`count` (1–8)** and writes **N individual `MOB#` items** (per-mob tracking, D5); Mob shape unchanged. Inline rename edits **`label` only**. |

### Round 5 (2026-07-17) — Domain & hosting
| # | Decision |
|---|---|
| D25 | **Domain = `rpgstatus.com`** (newly registered; Route 53 hosted zone already exists in the `jason-deploy` account). The app is served at **`wrathandglory.rpgstatus.com`**; the **apex `rpgstatus.com` redirects** (temporary **302** — the apex may later become a multi-game hub) to that host. **ACM cert (us-east-1)** covers `rpgstatus.com` + **`*.rpgstatus.com`** (wildcard future-proofs one subdomain per game, deferred). Redirect implemented as a **302 via a dedicated apex CloudFront distribution + a CloudFront Function** (not `HttpsRedirect`, which only emits a 301). Wired in step 3 (infra). |

### Round 6 (2026-07-18) — Post-start max correction
| # | Decision |
|---|---|
| D26 | **Wounds/Shock maximums are GM-correctable after start.** A max entered wrong at character setup no longer forces a rejoin: the GM console's party cards get a **✎ hero-edit dialog** (steppers + numeric inputs, "now at N" captions) that PATCHes the existing `maxWounds`/`maxShock` fields on `PATCH /players/{id}` with the **GM token** (already allowed by the §4 matrix; D23 limits apply). **Players cannot** change maxima post-setup from the main view — GM-only keeps the mid-session surface small. Lowering a max **re-clamps the stored current** down to match (server-side, same rule as setup). |

### Round 7 (2026-07-18) — Poll cadence
| # | Decision |
|---|---|
| D27 | **Casual-table poll cadence, not RTS sync.** The original ~2.5s shared poll made the freshness badge flip 0s↔1s and burned request budget for no table benefit. New cadence: **GM console 5s** (admits/table control lead), **player screen 8s** (passive board — the slower end, per Jason), **waiting-room claim stays 2.5s** (admission should land promptly). Mutations still trigger an **immediate refresh** for reconcile, and returning to a tab polls at once — only *passive* staleness grows. Freshness-indicator thresholds derive from the cadence so a healthy cycle always reads "fresh". |

---

## 3. Goals & Non-Goals

### Goals
- **G1 — Turn clarity.** Current round + who has / hasn't acted, visible to all.
- **G2 — Shared resource visibility.** Glory (always) and Ruin (GM-toggleable) in near-real-time; per-character Wrath on each character.
- **G3 — Party health at a glance.** Each character's Wounds/Shock + status, for healer planning.
- **G4 — Mob awareness.** Mob count + **coarse** health (healthy → dead); never exact HP; unrevealed mobs hidden until revealed.
- **G5 — Player self-service + GM override.**
- **G6 — Glory accountability.** Anyone can push/pull Glory; every change is **attributed and logged**; GM can export the log.
- **G7 — Rules help at hand.** Condition tooltips so nobody digs through the book.
- **G8 — Trivial setup & teardown.** Start in under a minute; auto-expire (TTL 3 days).
- **G9 — Abuse resistance.** GM-gated join + token auth + throttling; safe to run publicly.
- **G10 — Very cheap & scale-to-zero**, including under public multi-tenant use.

### Non-Goals (v1)
- Not a virtual tabletop (no maps/positions/LoS/distance — physical board stays authoritative).
- Not a rules/character-sheet engine — no dice, no automatic damage/rule resolution, no initiative engine, **no enforcement of the Glory-spend consensus rule**.
- No long-term accounts or cross-chapter history (beyond an exported log file).
- No streaming/spectator features (possible later).

---

## 4. Roles & Permissions

| Action | Player (own) | Player (others) | GM |
|---|:--:|:--:|:--:|
| View shared state | ✓ | ✓ | ✓ |
| Edit own Wounds/Shock/Wrath/conditions/acted/Down | ✓ | — | ✓ (override) |
| Push/Pull **Glory** (+/−, logged) | ✓ | ✓ | ✓ |
| Adjust **Ruin** / toggle Ruin visibility | — | — | ✓ |
| Advance round (reset acted) | — | — | ✓ |
| Manage mobs (HP, rename, reveal, duplicate, acted, conditions, kill) | — | — | ✓ |
| Admit/kick players, end session | — | — | ✓ |
| Export activity log | ✓ (own copy) | ✓ | ✓ |

---

## 5. Domain Model & Terminology

> ⚠️ **Rules note.** Target = **Core Rules**. Resource model is settled (D1/D9). Condition **names +
> help text** come from the GM's verified reference; see **Appendix A** and the build note there.

### Shared resources
- **Glory** — shared **party** pool. **Always visible.** **Push (+1) / Pull (−1) by any player or the
  GM**, each change attributed in the **activity log** (§5.4). Stored as an integer with an atomic
  increment (no read-modify-write races); **floor of 0** — decrements are conditional (D16).
- **Ruin** — global **GM** pool. **Visibility toggled by the GM.** GM-managed, atomic +/−, floor of
  0 (D16). (Ruin changes may also be logged.)

### Per-character state
- **Name** + **index** (`P1…Pn`, assigned at admit — used for compact log attribution).
- **Max/current Wounds** — primary damage track.
- **Max/current Shock** — secondary (stun/fatigue) track.
- **Wrath** — personal points (re-rolls, extra dice, cheating death). Clamped to **0–6** (D16).
- **Conditions** — tag list from the **14 Core conditions** (Appendix A, shipped as
  `/data/conditions.json` with tooltip help text). Each applied condition is `{ id, rank? }` — `rank`
  supports stackable conditions (e.g. *Hindered (2)*, *Bleeding (3)*). Conditions are added/removed
  manually (no auto-expiry). *Free-text custom conditions and a per-condition `note` field are
  deferred to v2 (D17).*
- **Status** — combat/defeated axis: `active` | `down` | `dying` | `dead` | `stable`.
- **Presence** — lobby/membership axis: `pending` | `admitted` | `ignored` | `removed` (D21).
  Independent of Status; selects which client takeover renders (waiting / not-admitted / removed).
- **Acted-this-round** — boolean for the turn checklist.

### Mobs (enemies/NPCs)
- **Label** — free text, **GM-editable at any time** (D18): a GM may start with "Mob 1" or
  "Grotesk Blob" and rename it once the party identifies the creature. Optional **tier**
  (Troops/Elite/Adversary, cosmetic).
- **Revealed** flag — added **unrevealed** (hidden from players), **revealed** on GM click.
- **Exact HP** (GM-only) → projected server-side to a **coarse indicator** for players:
  `healthy` (≥75%) → `minor injury` (40–74%) → `gravely injured` (1–39%) → `dead` (0%). Thresholds
  configurable; revisit after a playtest (Q-C, accepted for now).
- **Acted-this-round** — GM-facing turn flag per mob (D15); **never sent to players**; reset by
  "Next round" along with the players' flags.
- **Conditions** (optional). **Duplicate** action to clone stats; the add-mob dialog also takes a
  **count** (1–8) for "add 4 of the same" (D18).
- **Defaults:** new mob = "New Enemy", Troops, 6/6 HP, unrevealed. Player admit defaults: Wounds
  12/12, Shock 6/6 (current = max at setup), Wrath 0, status `active`.

### 5.4 Activity log (D10)
Compact, append-only, attributed record of resource changes — cheap to store and export.

- **Entry shape:** `[actorIndex, delta, typeCode, ts]`
  - `actorIndex`: player index (`1..n`) or `0` = GM.
  - `delta`: signed integer (e.g. `+1` push, `−1` pull).
  - `typeCode`: `"G"` = Glory, `"R"` = Ruin (extensible: round advance, etc.).
  - `ts`: epoch seconds (server-stamped).
  - Example `[1, 1, "G", 1721145600]` → frontend renders **"Bob pushed +1 to Glory"** (index→name via roster; type→label).
- **Volume:** a full day is at most a couple hundred entries → a few KB. Soft-cap ~1000 (trim oldest), comfortably under DynamoDB's 400KB item limit.
- **Export:** the log rides along in state, so the GM (or any client) exports it to a file **client-side** (JSON and/or human-readable CSV) — no backend call.

---

## 6. Feature Set (MVP vs. Stretch)

### MVP (v1)
1. GM creates session → join **code** + GM control view (GM token in localStorage).
2. **Lobby/admit** (anti-abuse); kick anytime.
3. Player setup: name, max Wounds, max Shock, starting Wrath.
4. **Turn checklist:** round number + per-player acted/not-yet; GM-only per-mob acted flags (D15);
   GM "Next round" resets both.
5. **Shared counters:** Glory (always, **player push/pull**) + Ruin (GM, toggleable); Wrath per character.
6. **Activity log** for Glory/Ruin changes; **GM export/download**.
7. **Party roster:** everyone's Wounds/Shock + status/conditions, visible to all.
8. **Player self-service:** edit own Wounds/Shock/Wrath/conditions/acted/Down.
9. **GM override:** edit any character.
10. **Mobs:** add via dialog (name, tier, max HP, count, starts-hidden — D18), inline rename, reveal,
    exact HP (GM) → coarse indicator (players), duplicate, acted flag, conditions, kill/remove.
11. **Condition tooltips** from shipped help text (Appendix A).
12. **Polling sync**; **TTL 3-day** auto-expiry; manual end-session.

### Stretch (v2+)
- Healer-oriented sorting/highlighting of injured allies.
- Read-only **spectator/TV** view.
- Save/re-import a party roster between chapters.
- Per-mob notes; damage log + undo; "reveal all"/group mob controls; mob templates.
- Custom free-text conditions + per-condition `note` field (D17).
- Log filters (by player / by resource).

*(Explicitly not planned: initiative engine — D6; Glory-consensus enforcement — D9.)*

---

## 7. UX Description (text only — for the design session)

> This is a **text description of screens, components, data shown, and states** — not visual design.
> Target implementation: **React + Vite + shadcn/ui + Tailwind**, **mobile-first** for players and a
> **responsive wider layout** for the GM.

### 7.1 Global / design-system notes
- **Two shells:** a phone-first **Player app** and a denser **GM console** (same data, more controls).
- **Theme:** a dark, high-contrast 40K feel is a natural fit and reads well in a dimly lit room —
  but glanceability > flavor. Big numbers, strong contrast.
- **Identity persistence:** each client stores its **token + role + session code + (player index)** in
  **localStorage** so a refresh/reboot returns straight to the session (D4/D13).
- **Freshness cue:** a subtle "updated Xs ago"/live dot, since sync is polling (several seconds of
  lag is expected and fine — casual-table pacing, D27).

### 7.2 Landing / entry (all)
Minimal, mobile-first: **"Start a session (GM)"** and a **"Join"** form (code + name). No login wall.
Invalid code → inline error.

### 7.3 GM — Create & Lobby
- **Start** → generates a **join code** shown large + a **Session Settings** panel: chapter name,
  initial Glory/Ruin, **"Show Ruin to players"** toggle. (Single 14-condition preset set, D17 — no
  preset picker.)
- **Lobby list** of pending joiners, each with **Admit** / **Ignore**; admitted players get an
  **index** and enter the roster; **Kick** available anytime.
- Header persists the **code** (for latecomers) and a **live session status/expiry** indicator.

### 7.4 Player — Join & Setup
- Enter code → name → **"waiting to be admitted."**
- On admit: a short setup card — **Max Wounds**, **Max Shock**, **starting Wrath** (sensible defaults
  + steppers) → **Done**.

### 7.5 Player — Main View (phone)
Single scrollable screen, priority top→bottom:
1. **Round & turn strip** (sticky): "Round 3." Player chips marked **✓ acted / • not yet**; *your*
   chip emphasized; a large **"I've acted"** self-toggle.
2. **Shared counters:** **Glory** (large, with **Push +1 / Pull −1** buttons available to the player)
   and **Ruin** (only if the GM enabled it). Values animate on change. A small **"log"** affordance
   opens the activity log (§7.7).
3. **Your character card:** **Wounds** & **Shock** bars + numbers with steppers; **Wrath** stepper;
   your **conditions** as add/removable chips (chip tap → tooltip, §7.8); a **Down** button. You edit
   only your own card.
4. **Party roster:** compact read-only rows — name, Wounds/Shock mini-bars, status + condition chips;
   injured/down allies visually stand out (G3).
5. **Mobs on the board:** a **count** ("4 enemies") + list of **coarse indicators** (healthy→dead as
   color **and** icon/label, not color alone). Unrevealed mobs are not shown. No numbers.

### 7.6 GM — Console (laptop, wider)
Everything players see, denser, multi-column, **plus inline controls**:
- **Counters row:** Glory & Ruin with **+/−** and **set-value**; **Ruin visibility toggle**.
- **Round control:** **Next round** (confirm — resets acted flags); manual per-player acted toggles.
- **Party panel:** each character editable — Wounds/Shock/Wrath steppers, **condition picker**
  (presets + custom), **status** dropdown (active/down/dying/dead/stable), **✎ hero-edit dialog**
  (correct the setup **max** Wounds/Shock mid-session — D26). (GM override.)
- **Mob panel:** **Add mob** dialog (label, tier, max HP, count 1–8, starts-hidden — D18) → defaults
  **unrevealed**; **inline rename** (click the name — D18); per-mob **acted** toggle (D15); **Reveal**
  toggle; **Duplicate**; exact-HP stepper **with the derived coarse badge shown beside it**;
  conditions; **kill/remove**.
- **Activity log panel** (§7.7) with **Export**.
- **Session panel:** code, lobby/admits, kick, **end session**, expiry indicator.

### 7.7 Activity log & export
- A scrollable, reverse-chronological list rendered from compact entries → human strings
  ("Bob pushed +1 to Glory — 8:41pm", "Alice spent 1 Glory — 8:42pm").
- **Export** button downloads the log **client-side** (JSON and/or CSV). Available to the GM
  prominently; players may export their own view.

### 7.8 Condition chips & tooltips
- Conditions render as **chips** on character cards/rows. Tap/hover → a **tooltip/popover** with the
  condition's **name + short effect summary** (shipped help text, Appendix A), optionally a rulebook
  page ref. GM's **condition picker** is the list of the 14 presets (with the same help text);
  custom free-text conditions and the note field are v2 (D17).

### 7.9 Shared component inventory (for design)
Counter (big number + +/− + optional set), **Wounds/Shock bar** (labeled, numeric, color+state),
**coarse-HP badge** (icon+label+color), **condition chip** (+ tooltip), **player/turn chip**
(acted state), **stepper**, **roster row**, **mob card**, **lobby row** (admit/ignore), **log row**,
toast/banner for connection & session states.

### 7.10 States to design (each screen)
Loading/hydrating; empty (no players yet / no mobs); **"waiting to be admitted"**; **"removed by
GM"**; **"session ended"**; **"session expired"**; **"token invalid → rejoin"**; reconnecting/stale;
optimistic-edit pending → reconciled.

### 7.11 At-the-table & accessibility
Glanceable from across a table (large type, high contrast); **status by color + icon/text**, never
color alone (colorblind-safe); big tap targets (phones, possibly greasy dice fingers); works in a dim
room; minimal typing after setup.

---

## 8. Technical Architecture

Fully **serverless on AWS (us-east-1)**, scale-to-zero, cheap under public multi-tenant use.
**Polling**, with the read path **cached at the CloudFront edge** so poll volume barely touches the
backend, and **API Gateway throttling + token auth** for lock-down.

```
                 ┌──────────────────────────────────────────────┐
   Player phones │  Static SPA (React + Vite + shadcn/Tailwind)  │
   GM laptop     │  on S3, served via CloudFront                 │
                 └───────────────┬──────────────────────────────┘
                                 │ HTTPS  (token in header)
                 ┌───────────────▼──────────────────────────────┐
                 │  CloudFront (+ optional WAF rate rule)        │
                 │   • /              → S3 static assets         │
                 │   • GET /state/<code> → cached ~1–2s          │
                 │        (token checked at edge via CF Function)│
                 │   • POST /… (mutations) → pass-through        │
                 └───────────────┬──────────────────────────────┘
                                 │ (cache miss / mutations only)
                 ┌───────────────▼──────────────────────────────┐
                 │  API Gateway HTTP API (per-route throttling)  │
                 │        → Lambda (Node/TS)                     │
                 │  role/scope checks, coarse-HP projection,     │
                 │  atomic counter updates, log append           │
                 └───────────────┬──────────────────────────────┘
                                 │
                 ┌───────────────▼──────────────────────────────┐
                 │  DynamoDB single table (on-demand, TTL 3d)    │
                 │  session / players / mobs / log               │
                 └──────────────────────────────────────────────┘
```

- **Read path:** clients `GET /state/<code>` every ~2–3s. CloudFront caches per-code ~1–2s, so N
  clients collapse to ~1 origin read per cache window per session. `If-None-Match` enables cheap 304s.
- **Write path:** `POST /…` mutations skip cache → API GW (throttled) → Lambda → DynamoDB
  (atomic updates / log append). Bounded staleness = cacheTTL + poll ≈ several seconds (D27).
- **Coarse mob HP** and **unrevealed filtering** happen **server-side**; player tokens never receive
  exact HP or hidden mobs.

---

## 9. Data Model (DynamoDB single table)

One table, on-demand, **TTL (3 days)**. All of a session's items share the partition key, so one
`Query` hydrates the whole board.

| Item | PK | SK | Key attributes |
|---|---|---|---|
| Session meta | `SESSION#<code>` | `META` | `state`, `glory`, `ruin`, `showRuin`, `round`, `settings{…}`, `gmTokenHash`, `nextPlayerIndex`, `createdAt`, `ttl` |
| Player | `SESSION#<code>` | `PLAYER#<id>` | `index`, `name`, `maxWounds`, `wounds`, `maxShock`, `shock`, `wrath`, `conditions[]`, `status`, `actedThisRound`, `presence`, `playerTokenHash`, `joinedAt`, `ttl` |
| Mob | `SESSION#<code>` | `MOB#<id>` | `label`, `tier`, `maxHp`, `hp`, `revealed`, `actedThisRound`, `conditions[]`, `ttl` |
| Log | `SESSION#<code>` | `LOG` | `e` (list of `[actorIndex, delta, typeCode, ts]`), `ttl` |

### 9.1 Access patterns
- **Hydrate board:** `Query PK = SESSION#<code>` → meta + players + mobs + log in one call. The read
  handler **projects mob HP to a coarse label** and **strips unrevealed mobs / exact HP / mob acted
  flags** for player tokens.
- **Mutations are per-item, mostly atomic:**
  - Counters: `UpdateItem … ADD glory :d` / `ADD ruin :d` (atomic — no lost updates). Decrements
    carry a condition expression (e.g. `glory >= :abs(d)`) so pools floor at 0 (D16).
  - Log append: `UpdateItem SET e = list_append(if_not_exists(e, :empty), :entry)` (atomic; concurrent appends serialize cleanly).
  - Player edits only their `PLAYER#<id>`; GM may edit any item.
  - Mob duplicate = `PutItem` new `MOB#<id>` copied from source.
  - "Next round" = set every player's **and mob's** `actedThisRound=false` + bump `round` (D15).
  - Mob rename/edit = GM-only `UpdateItem` on `MOB#<id>` (`label`, `tier`, `maxHp` — D18).
  - Add mob = **N `PutItem`s** for `count` (1–8) individual `MOB#` items (D24).
  - Admit = set `presence='admitted'` + assign `index`; **Ignore/Kick = set `presence='ignored'|'removed'`** (soft tombstone; TTL cleans up — never a hard delete, D21).

### 9.2 Lifecycle & cleanup
- **TTL (3 days)** auto-deletes an entire session — no teardown, satisfies retention with zero ops.
  (The GM's exported log file is the only thing that outlives a session, and it lives on their disk.)
- Server is source of truth; concurrent edits to different items never conflict; shared counters are
  atomic → **"several people editing at once" is structurally a non-issue.**

### 9.3 Why DynamoDB, not an S3 state file *(round-1 question)*
Using one S3 JSON file per session to "drive DB reads to ~zero" optimizes the wrong axis and adds a
correctness hazard:
- **Reads are the volume (polling), and DynamoDB reads are *cheaper* than S3 GETs** — small-item read
  ≈ **$0.125/M** vs S3 GET ≈ **$0.40/M** (~3×). Writes: DynamoDB ≈ **$1.25/M** vs S3 PUT ≈ **$5.00/M**
  (~4×). DynamoDB wins on both.
- **A single S3 file is a lost-update trap:** concurrent GET→modify→PUT overwrites; guarding with
  `If-Match`/ETag forces retries → *more* PUTs and serialized edits. DynamoDB per-item + atomic
  counters/log-append avoids it entirely.
- **The real read-cost lever is edge caching, not the datastore.** A ~2s CloudFront TTL collapses a
  4-hour, 11-player session from ~52,800 origin reads to ~7,200 regardless of client count.

| Per 4h, 11-player session | reads | writes | total |
|---|---|---|---|
| DynamoDB (per-item)      | ~$0.0066 | ~$0.0004 | **~$0.007** |
| S3 (whole-file)          | ~$0.0211 | ~$0.0015 | **~$0.023** |
| DynamoDB + 2s edge cache | ~$0.0009 | ~$0.0004 | **~$0.001** |

Both are fractions of a cent, so cost isn't the deciding factor at 11 users — but DynamoDB is cheaper
*and* dodges the concurrency headache. Keep S3 only for hosting the static app.

---

## 10. Session Lifecycle & Join Flow

1. **Create (GM).** `POST /sessions` → server generates a **code** + a signed **GM token**
   (localStorage). Session is `active` from creation — admission is continuous (D22).
2. **Join (Player).** `POST /sessions/<code>/join {name}` → player created `presence='pending'`; on admit
   they receive a signed **player token** (localStorage) + an **index**.
3. **Admit (GM).** GM taps **Admit** → `presence='admitted'`; player enters the roster. **Ignore** (pending) → `ignored`, **Kick** (admitted) → `removed` — soft tombstones (D21).
4. **Play.** Mutations flow with role/scope checks; everyone polls the (cached) state.
5. **End / expire.** GM ends manually, or **TTL (3d)** auto-cleans. GM may **export the log** before/after.

---

## 11. Consistency, Polling & GM Resilience

- **Server-authoritative.** Clients render optimistically, reconcile to the next polled snapshot →
  no drift. Bounded staleness = cacheTTL + poll ≈ several seconds (fine for a status board;
  cadence per D27: GM 5s, player 8s, waiting-room claim 2.5s).
- **Atomic shared counters & log-append** → simultaneous pushes/pulls never clobber.
- **GM reboot / lost connection (D4).** GM token in **localStorage** survives a browser restart; state
  is server-side, so on reconnect the GM re-reads current state and loses nothing. **Different-laptop
  recovery is out of scope** (no account/PIN).
- **Player reconnect.** On return, the client re-presents its token and re-reads state — identity + index preserved.

---

## 12. Security & Abuse Prevention

Target: **low friction, no accounts, safe to run publicly** — the specific worry is a script kiddie
hammering the endpoint and disrupting live games.

- **GM-gated lobby (primary).** A code does nothing until the GM admits you; a wrong-code stranger
  sits in a list the GM ignores.
- **Signed, expiring tokens (D13).** On create/admit, the server issues an **HMAC-signed token**
  encoding `{code, role, playerIndex, exp}` (exp ≤ 48h). **Stateless** → validated without a DB
  lookup.
  - **Mutations (`POST`)** require a valid token; Lambda enforces **scope** (player → own character +
    Glory push/pull; GM → anything). Invalid/expired → 401.
  - **Reads (`GET /state/<code>`)** — to stay both edge-cached *and* protected, validate the token at
    the **edge with a CloudFront Function** (checks HMAC/exp, no backend call) before serving from
    cache; cache key is `<code>` only so valid holders share one cached object. *Simplest baseline if
    we skip edge auth:* treat the **code as the read capability** and lengthen codes (6–8 chars) —
    weaker, but fine to start.
- **Throttling (D12).** API Gateway HTTP API applies **per-route rate + burst limits**; put a
  **stricter limit on `create`/`join`** (the uncacheable, abusable routes). Cache `403/404` briefly so
  bad codes don't reach the origin.
- **Lock the origin.** Only CloudFront should reach the backend. With API GW that's a header/OAC
  restriction; **if a Lambda Function URL is ever used instead, it MUST sit behind CloudFront**
  (IAM/OAC or secret header) since it has no native throttling.
- **Optional AWS WAF** rate-based rule on CloudFront (~$6/mo) as a paid upgrade if public abuse
  actually appears — not part of the cheap baseline.
- **Data minimization.** Only display names; coarse-HP/unrevealed filtering is **server-side**; TTL
  guarantees nothing lingers.

---

## 13. Cost

Scale-to-zero; **fractions of a cent per session** (§9.3), cheap even public:
- **Lambda:** within free tier; edge caching means most polls never invoke it.
- **API Gateway HTTP API:** $1.00/M requests — but cached reads don't hit it, so effectively pennies.
- **DynamoDB (on-demand + TTL):** ~$0.001–0.007/session, within/near free tier.
- **CloudFront + S3 + CloudFront Function:** pennies/month; CF Function invocations ≈ $0.10/M.
- **~100 concurrent public sessions, edge-cached:** on the order of **cents** in reads+writes.
- **Optional WAF:** ~$6/mo base **only if** enabled.
- **Custom domain:** `rpgstatus.com` registered + Route 53 hosted zone (~$0.50/mo); ACM certs are
  free; the apex 302 redirect adds a tiny S3+CloudFront (pennies).

**Expected: within/near free tier for hobby use**; low single-digit $/month even with modest public
traffic (WAF is the main thing that would move the needle).

---

## 14. Tech Stack, Repo Structure, IaC

- **IaC:** AWS **CDK (TypeScript)**, single stack (S3+CloudFront[+CF Function][+WAF], API GW HTTP API,
  Lambda, DynamoDB), **us-east-1**.
- **Domain/DNS (D25):** **`rpgstatus.com`** in Route 53 (existing hosted zone, `jason-deploy` account);
  app host **`wrathandglory.rpgstatus.com`** as a CloudFront alternate domain; **ACM cert us-east-1**
  for `rpgstatus.com` + `*.rpgstatus.com`; **apex → app** 302 redirect via a CloudFront Function on a
  dedicated apex distribution. Future games = sibling `<game>.rpgstatus.com` hosts (deferred).
- **Frontend:** **React + Vite + shadcn/ui + Tailwind**; mobile-first player app + responsive GM
  console; built assets → S3 → CloudFront.
- **Backend:** **TypeScript Lambda**; shared domain types (`Session`/`Player`/`Mob`/`LogEntry`) with
  the frontend; a shipped **`conditions.json`** (Appendix A).
- **Layout:**
  ```
  /infra       CDK app (single stack)
  /backend     Lambda handlers + domain logic + shared types
  /frontend    React/Vite SPA (player + GM)
  /data        conditions.json (names + help text)
  /docs        this spec, ADRs
  ```
- **Deploy:** `cdk deploy --profile jason-deploy` (us-east-1); optional GitHub Action later.

---

## 15. Phased Roadmap

- **Phase 0 — Skeleton:** CDK stack (DynamoDB, API GW+Lambda, CloudFront+S3), create/join/admit,
  cached `GET /state`, token issuance/validation. Prove the Jackbox flow end-to-end.
- **Phase 1 — MVP:** turn checklist; Glory (player push/pull) + Ruin (toggle) + **activity log +
  export**; party roster (Wounds/Shock/Wrath); **self-service + GM override**; mobs
  (unrevealed/reveal/duplicate + coarse HP); **condition tooltips**; polling; TTL.
- **Phase 2 — Public-ready:** edge token check, throttling tuning, code uniqueness, small landing
  page, reconnect polish, optional WAF.
- **Phase 3 — Nice-to-haves:** healer highlighting, spectator/TV view, roster re-import, mob
  notes/undo, log filters.

---

## 16. Open Questions

Rounds 1–2 are resolved (§2). Remaining:
- **Q-B — Condition content. ✅ Resolved.** The 14 Core conditions + paraphrased tooltip summaries
  are captured in `/data/conditions.json` (Appendix A) from the GM's verified reference. *Remaining
  nit:* give the summaries one proof-read against the book before any **public** release (they're
  paraphrased, but confirm no wording is too close to the original).
- **Q-C — Coarse-HP thresholds.** Accepted as 75/40/1/0% for now; revisit after a playtest.
- **UX/Claude Design pass. ✅ Resolved (Rounds 3–4, D15–D24).** The GM Console + Player Screen review
  fed §5/§9 (mob acted flag, counter bounds, deferred note/custom, mob rename, chip categories);
  Round 4 folded in Entry/Join, GM Setup & GM Console v2 (presence lifecycle, live-from-creation,
  settings/limits, batch add-mob). Remaining design gaps (low-effort, non-blocking): token-invalid →
  rejoin, empty-no-mobs, and the optimistic-pending edit state.

---

## 17. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Condition text copyright-heavy | `conditions.json` ships **paraphrased** summaries (not verbatim) from the verified reference; proof-read before public release; presets + custom stay editable. |
| Public abuse (endpoint hammering, code-guessing) | Token auth (edge-validated reads), API GW throttling, origin locked behind CloudFront, brief 403/404 caching, optional WAF (§12). |
| Lost updates from concurrent edits / Glory pushes | Per-item writes, atomic counters, atomic log-append (§9). |
| Polling staleness feels laggy | ~2s cache + 5s GM / 8s player poll (D27 — deliberate casual-table pace); mutations refresh immediately; tune cadence/TTL; WebSockets remain a later option. |
| Scope creep into a VTT / rules engine | Explicit non-goals (§3); board stays authoritative; no consensus/initiative enforcement. |
| GM loses connection/reboots | localStorage token + server-authoritative state (§11); different-laptop out of scope by choice. |

---

## Appendix A — Condition help text (Core Rules)

> Captured from the GM's verified reference and shipped as **`/data/conditions.json`**
> (`{ id, name, stacks, category, summary }` + a `general` rules array — `category` drives chip
> theming: `damage` / `affliction` / `impairment`, D19). Summaries are **concise paraphrases**
> for tooltips, **not verbatim** rulebook text — proof-read before any public release. `stacks: true`
> conditions take a rank (e.g. *Hindered (2)*, *Bleeding (3)*).

**General rules (shown as a "How conditions work" blurb):** conditions represent harm outside Wounds;
a condition may end at the end of a scene (GM discretion) while some persist until treated; the same
condition can apply more than once and stacks; similar penalties from different conditions don't stack
(use the worst); Defence has a floor of 1.

| Condition | Stacks | Short help (paraphrased) |
|---|:--:|---|
| Bleeding | ✓ | 1 Mortal Wound at the end of each of your turns (per rank); ends on a Toughness test (DN 4) or ally Medicae. |
| Blinded |  | +4 DN to all sight-based tasks incl. every Combat test (replaces lesser vision penalties); removable with a Combat Action (GM discretion). |
| Exhausted |  | Only Walk/Crawl, basic attack, or Fall Back; no Determination; Shock you take converts to Mortal Wounds; ends when you recover Shock. |
| Fear |  | Roll Resolve vs source DN; on fail, +2 DN to all tests until scene end / an ally's Leadership test. |
| Frenzied |  | Must charge & All-Out Attack the nearest enemy; immune to Fear, can't be Pinned, +1 Strength; resist with DN 3 Willpower at turn start. |
| Hindered | ✓ | +1 DN to all tests per rank; lasts until the end of your next turn unless stated. |
| On Fire |  | 1d3 Mortal Wounds at the start of each turn; go Prone + DN 3 Athletics to douse, or DN 3 Willpower to ignore (else Hindered). |
| Pinned |  | Can't leave cover (move to nearest cover if exposed); +2 DN firing back at the pinner; ended by an ally's Leadership rally. |
| Poisoned |  | +2 DN to all tests; ends via Medicae or a Toughness test at the start of your turn. |
| Prone |  | Defence −2 vs attackers within 5m, +1 vs attacks from 6m+; standing up is a Free Action (Standard Movement only). |
| Restrained |  | Can't use Movement; Defence −2. |
| Staggered |  | Speed halved; can't Run/Sprint; lasts until the end of your next turn. |
| Terror |  | Roll Resolve vs source DN; on fail suffer Fear's effects and must flee until out of line of sight. |
| Vulnerable |  | Defence −1 (some effects increase it); lasts until the end of your next turn. |

*Separate from these conditions, **status flags** track the defeated track (from Wounds/Shock, not the
list above): **Down** (incapacitated), **Dying**, **Dead**, **Stable**.*
