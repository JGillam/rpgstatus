// Pure, dependency-free helpers for the shipped condition data (/data/conditions.json).
// The module never imports the JSON itself — each app loads its bundled copy and passes
// it through parseConditions() to get a validated, typed ConditionsFile.

import type { ConditionsFile, ConditionDef, ConditionCategory } from './types';

const CATEGORIES: readonly ConditionCategory[] = ['damage', 'affliction', 'impairment'];

function isCategory(v: unknown): v is ConditionCategory {
  return typeof v === 'string' && (CATEGORIES as readonly string[]).includes(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Runtime validator: narrows unknown JSON to ConditionsFile, throwing a descriptive
 * Error on any mismatch. Hand-rolled (no zod) so the module stays dependency-free.
 */
export function parseConditions(raw: unknown): ConditionsFile {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('conditions: root must be an object');
  }
  const obj = raw as Record<string, unknown>;

  const edition = obj.edition;
  const note = obj.note;
  const reference = obj.reference;
  if (typeof edition !== 'string') throw new Error('conditions: "edition" must be a string');
  if (typeof note !== 'string') throw new Error('conditions: "note" must be a string');
  if (typeof reference !== 'string') throw new Error('conditions: "reference" must be a string');

  const categoryNote = obj.categoryNote;
  if (categoryNote !== undefined && typeof categoryNote !== 'string') {
    throw new Error('conditions: "categoryNote" must be a string when present');
  }

  const general = obj.general;
  if (!isStringArray(general)) throw new Error('conditions: "general" must be a string[]');

  const rawConditions = obj.conditions;
  if (!Array.isArray(rawConditions) || rawConditions.length === 0) {
    throw new Error('conditions: "conditions" must be a non-empty array');
  }

  const seen = new Set<string>();
  const items: unknown[] = rawConditions;
  const conditions: ConditionDef[] = items.map((item, i) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`conditions[${i}]: must be an object`);
    }
    const c = item as Record<string, unknown>;
    const id = c.id;
    const name = c.name;
    const stacks = c.stacks;
    const category = c.category;
    const summary = c.summary;

    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`conditions[${i}]: "id" must be a non-empty string`);
    }
    if (seen.has(id)) throw new Error(`conditions[${i}]: duplicate id "${id}"`);
    seen.add(id);
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`conditions[${id}]: "name" must be a non-empty string`);
    }
    if (typeof stacks !== 'boolean') {
      throw new Error(`conditions[${id}]: "stacks" must be a boolean`);
    }
    if (!isCategory(category)) {
      throw new Error(`conditions[${id}]: "category" must be one of ${CATEGORIES.join(', ')}`);
    }
    if (typeof summary !== 'string' || summary.length === 0) {
      throw new Error(`conditions[${id}]: "summary" must be a non-empty string`);
    }
    return { id, name, stacks, category, summary };
  });

  return {
    edition,
    note,
    reference,
    ...(categoryNote !== undefined ? { categoryNote } : {}),
    general,
    conditions,
  };
}

/** Build an id → ConditionDef lookup. */
export function indexConditions(file: ConditionsFile): Map<string, ConditionDef> {
  return new Map(file.conditions.map((c) => [c.id, c]));
}
