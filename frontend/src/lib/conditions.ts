// Loads the shipped condition data (/data/conditions.json via the @data alias) once at
// module init and runs it through the pure domain validator. Exposes the ordered preset
// list (for the picker) and an id→def lookup (for chips + tooltips). Authority: SPEC §7.8.

import conditionsJson from '@data/conditions.json';
import { indexConditions, parseConditions, type ConditionDef } from '@domain';

const file = parseConditions(conditionsJson);

/** The 14 presets in authored order — the source of truth for the condition picker. */
export const CONDITIONS: readonly ConditionDef[] = file.conditions;

/** id → ConditionDef ({ name, summary, stacks, category }) for chip labels + tooltips. */
export const CONDITIONS_BY_ID: ReadonlyMap<string, ConditionDef> = indexConditions(file);

/** Look up a single condition definition; undefined for unknown/custom ids. */
export const conditionDef = (id: string): ConditionDef | undefined => CONDITIONS_BY_ID.get(id);
