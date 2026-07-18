import { describe, expect, it } from 'vitest';
import { buildWeeklyReport, monthsThrough, statsMonth, type SessionStatsRow } from './stats';

const DAY = 86_400;

function row(partial: Partial<SessionStatsRow>): SessionStatsRow {
  return { created: 0, players: 0, rounds: 1, state: 'ended', harvestedAt: 0, ...partial };
}

describe('statsMonth', () => {
  it('maps epoch seconds to the UTC yyyy-mm', () => {
    // 2026-07-18T12:00:00Z
    expect(statsMonth(1784376000)).toBe('2026-07');
    // Month boundary: 2026-07-31T23:59:59Z stays July; +1s flips to August.
    expect(statsMonth(1785542399)).toBe('2026-07');
    expect(statsMonth(1785542400)).toBe('2026-08');
  });
});

describe('monthsThrough', () => {
  it('enumerates inclusive months across a year boundary', () => {
    expect(monthsThrough('2026-11', new Date(Date.UTC(2027, 1, 15)))).toEqual([
      '2026-11',
      '2026-12',
      '2027-01',
      '2027-02',
    ]);
  });

  it('returns just the start month when now is inside it', () => {
    expect(monthsThrough('2026-07', new Date(Date.UTC(2026, 6, 18)))).toEqual(['2026-07']);
  });

  it('returns empty for a start month after now, or malformed input', () => {
    expect(monthsThrough('2026-09', new Date(Date.UTC(2026, 6, 18)))).toEqual([]);
    expect(monthsThrough('garbage', new Date(Date.UTC(2026, 6, 18)))).toEqual([]);
  });
});

describe('buildWeeklyReport', () => {
  const end = 1784376000; // 2026-07-18T12:00:00Z
  const start = end - 7 * DAY;

  it('reports only sessions harvested inside the window, with distributions and by-day lines', () => {
    const all: SessionStatsRow[] = [
      row({ created: end - 6 * DAY, players: 2, rounds: 4, harvestedAt: end - 3 * DAY }),
      row({ created: end - 6 * DAY, players: 8, rounds: 9, harvestedAt: end - 2 * DAY }),
      row({ created: end - 5 * DAY, players: 5, rounds: 6, harvestedAt: end - DAY }),
      // Outside the window (older) — lifetime only.
      row({ created: end - 40 * DAY, players: 10, rounds: 12, harvestedAt: end - 36 * DAY }),
      // Boundary: harvested exactly at windowEnd is NOT included (half-open window).
      row({ created: end - DAY, players: 3, rounds: 2, harvestedAt: end }),
    ];
    const { subject, body } = buildWeeklyReport(all, start, end);

    expect(subject).toBe('rpgstatus weekly: 3 sessions (week ending 2026-07-18)');
    expect(body).toContain('Sessions this week: 3');
    expect(body).toContain(`created ${new Date((end - 6 * DAY) * 1000).toISOString().slice(0, 10)} ×2`);
    expect(body).toContain('Players per session: min 2 · median 5 · max 8');
    expect(body).toContain('Rounds reached: median 6 · max 9');
    expect(body).toContain('Lifetime: 5 sessions · 28 player-seats');
  });

  it('formats an even-count median with one decimal and singularizes the subject', () => {
    const all = [
      row({ players: 4, rounds: 5, created: end - 2 * DAY, harvestedAt: end - DAY }),
      row({ players: 9, rounds: 6, created: end - 2 * DAY, harvestedAt: end - DAY }),
    ];
    const { body } = buildWeeklyReport(all, start, end);
    expect(body).toContain('median 6.5');

    const one = buildWeeklyReport(all.slice(0, 1), start, end);
    expect(one.subject).toContain('1 session (');
  });

  it('handles an empty week (heartbeat) without distribution lines', () => {
    const { subject, body } = buildWeeklyReport([], start, end);
    expect(subject).toContain('0 sessions');
    expect(body).toContain('Sessions this week: 0');
    expect(body).not.toContain('Players per session');
    expect(body).toContain('Lifetime: 0 sessions · 0 player-seats');
  });
});
