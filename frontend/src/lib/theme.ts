// Maps domain enums to theme token colors (CSS variables from index.css) and readable
// labels. Returned colors are `var(--color-…)` strings, usable in inline styles or as
// arbitrary Tailwind values (e.g. text-[var(--color-healthy)]). Used by the GM/player
// screens built in later steps.

import type { CoarseHp, ConditionCategory, PlayerStatus } from '@domain';

const COARSE_COLORS: Record<CoarseHp, string> = {
  healthy: 'var(--color-healthy)',
  minor: 'var(--color-minor)',
  gravely: 'var(--color-gravely)',
  dead: 'var(--color-dead)',
};

const COARSE_LABELS: Record<CoarseHp, string> = {
  healthy: 'Healthy',
  minor: 'Wounded',
  gravely: 'Gravely wounded',
  dead: 'Dead',
};

const STATUS_COLORS: Record<PlayerStatus, string> = {
  active: 'var(--color-status-active)',
  down: 'var(--color-status-down)',
  dying: 'var(--color-status-dying)',
  dead: 'var(--color-status-dead)',
  stable: 'var(--color-status-stable)',
};

const STATUS_LABELS: Record<PlayerStatus, string> = {
  active: 'Active',
  down: 'Down',
  dying: 'Dying',
  dead: 'Dead',
  stable: 'Stable',
};

// Condition-chip theming (D19): damage = ongoing harm, affliction = mind/toxin,
// impairment = restrictions/penalties.
const CONDITION_COLORS: Record<ConditionCategory, string> = {
  damage: 'var(--color-red)',
  affliction: 'var(--color-violet)',
  impairment: 'var(--color-blue)',
};

export const coarseColor = (c: CoarseHp): string => COARSE_COLORS[c];
export const coarseLabel = (c: CoarseHp): string => COARSE_LABELS[c];
export const statusColor = (s: PlayerStatus): string => STATUS_COLORS[s];
export const statusLabel = (s: PlayerStatus): string => STATUS_LABELS[s];
export const conditionColor = (c: ConditionCategory): string => CONDITION_COLORS[c];
