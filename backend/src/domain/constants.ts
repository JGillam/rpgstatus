// Pure literal constants shared by backend and frontend. Authority: docs/SPEC.md,
// decisions D16, D18, D19, D20, D23. No logic here — the coarse() projection and
// validators live in the domain logic (step 2) / conditions.ts.

/** Validation bounds (D16, D23). */
export const LIMITS = {
  name: { min: 1, max: 24 },
  chapterName: { max: 48 },
  maxWounds: { min: 1, max: 40 },
  maxShock: { min: 1, max: 20 },
  wrath: { min: 0, max: 6 },
  mobMaxHp: { min: 1 },
  addMobCount: { min: 1, max: 8 },
  counter: { min: 0 }, // Glory / Ruin floor (D16)
} as const;

/** Join code format (D20/D23): 5 chars from an unambiguous alphabet (no I/O/0/1). */
export const JOIN_CODE = {
  length: 5,
  alphabet: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
} as const;

/** Setup / create defaults surfaced by the design prototypes (§5, D18, D23). */
export const DEFAULTS = {
  player: { maxWounds: 12, maxShock: 6, wrath: 0 },
  mob: { label: 'New Enemy', tier: 'Troops', maxHp: 6, count: 1, startsHidden: true },
  session: { glory: 0, ruin: 0, showRuin: false },
  chapterNameFallback: 'Untitled chapter',
} as const;

/**
 * Coarse-HP thresholds as fractions of maxHp (Q-C): healthy ≥0.75, minor ≥0.40,
 * gravely >0 & <0.40, dead ≤0. The coarse() projection itself lives in step 2.
 */
export const COARSE_THRESHOLDS = { healthy: 0.75, minor: 0.4 } as const;

export const CONDITION_CATEGORIES = ['damage', 'affliction', 'impairment'] as const;
