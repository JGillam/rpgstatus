import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseConditions, indexConditions } from './index';
import type { PlayerPresence, PlayerStatus } from './index';

// Resolve /data/conditions.json relative to this file (domain -> src -> backend -> repo root).
const here = dirname(fileURLToPath(import.meta.url));
const conditionsPath = resolve(here, '../../../data/conditions.json');
const raw: unknown = JSON.parse(readFileSync(conditionsPath, 'utf8'));

describe('conditions.json contract', () => {
  const file = parseConditions(raw);

  it('parses without throwing and has exactly 14 conditions', () => {
    expect(file.conditions).toHaveLength(14);
  });

  it('has unique ids', () => {
    const ids = file.conditions.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every category is one of the three allowed values', () => {
    const allowed = new Set<string>(['damage', 'affliction', 'impairment']);
    for (const c of file.conditions) expect(allowed.has(c.category)).toBe(true);
  });

  it('stacks is boolean; bleeding and hindered stack', () => {
    for (const c of file.conditions) expect(typeof c.stacks).toBe('boolean');
    const byId = indexConditions(file);
    expect(byId.size).toBe(14);
    expect(byId.get('bleeding')?.stacks).toBe(true);
    expect(byId.get('hindered')?.stacks).toBe(true);
  });

  it('rejects malformed input', () => {
    expect(() => parseConditions(null)).toThrow();
    expect(() => parseConditions({ conditions: [] })).toThrow();
    expect(() => parseConditions({ edition: 'x', note: 'x', reference: 'x', general: [], conditions: [] })).toThrow();
  });
});

describe('type unions accept expected literals', () => {
  it('presence and status literals are assignable', () => {
    const presence: PlayerPresence = 'admitted';
    const status: PlayerStatus = 'dying';
    expect(presence).toBe('admitted');
    expect(status).toBe('dying');
  });
});
