// Anonymous usage stats (D28) — pure aggregation logic for the weekly report.
// Deliberately NOT exported from the domain barrel (index.ts): the barrel is the
// frontend-shared surface, and stats are a backend-only concern.

/** One permanent stats row, written by the statsHarvest handler at TTL reap. */
export interface SessionStatsRow {
  /** Session createdAt (epoch seconds). */
  created: number;
  /** Players ever admitted (META.nextPlayerIndex at reap — starts at 0, bumped per admit). */
  players: number;
  /** Final round counter (starts at 1). */
  rounds: number;
  /** Session state at reap ('active' | 'ended'). */
  state: string;
  /** When the harvest Lambda saw the TTL delete (epoch seconds). */
  harvestedAt: number;
}

/** STATS partition key suffix for the month a session was created in (UTC, 'yyyy-mm'). */
export function statsMonth(createdAtSec: number): string {
  return new Date(createdAtSec * 1000).toISOString().slice(0, 7);
}

/** Every month key from startMonth ('yyyy-mm') through the month of `now`, inclusive. */
export function monthsThrough(startMonth: string, now: Date): string[] {
  const [startY, startM] = startMonth.split('-').map(Number);
  if (!startY || !startM) return [];
  const endY = now.getUTCFullYear();
  const endM = now.getUTCMonth() + 1;
  const out: string[] = [];
  let y = startY;
  let m = startM;
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    if (m === 12) {
      y += 1;
      m = 1;
    } else {
      m += 1;
    }
  }
  return out;
}

export interface WeeklyReport {
  subject: string;
  body: string;
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));

const isoDate = (epochSec: number): string => new Date(epochSec * 1000).toISOString().slice(0, 10);

/**
 * Build the weekly email from ALL stats rows. The window is over `harvestedAt`
 * — a session is reported in the week its TTL reap was harvested — so every
 * session lands in exactly one weekly email, even though reaping trails
 * creation by the TTL (~3 days) plus DynamoDB's reap lag.
 */
export function buildWeeklyReport(
  all: SessionStatsRow[],
  windowStartSec: number,
  windowEndSec: number,
): WeeklyReport {
  const recent = all.filter((r) => r.harvestedAt >= windowStartSec && r.harvestedAt < windowEndSec);
  const endDate = isoDate(windowEndSec);

  const lines: string[] = [
    `Wrath & Glory session stats — week ending ${endDate}`,
    '',
    `Sessions this week: ${recent.length}`,
  ];

  if (recent.length > 0) {
    const byDay = new Map<string, number>();
    for (const r of recent) {
      const day = isoDate(r.created);
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
    }
    for (const [day, count] of [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`  created ${day} ×${count}`);
    }
    const players = recent.map((r) => r.players);
    const rounds = recent.map((r) => r.rounds);
    lines.push(
      '',
      `Players per session: min ${Math.min(...players)} · median ${fmt(median(players))} · max ${Math.max(...players)}`,
      `Rounds reached: median ${fmt(median(rounds))} · max ${Math.max(...rounds)}`,
    );
  }

  const lifetimePlayers = all.reduce((sum, r) => sum + r.players, 0);
  lines.push(
    '',
    `Lifetime: ${all.length} sessions · ${lifetimePlayers} player-seats`,
    '',
    'A session is counted when its 3-day TTL reaps it, so counts trail creation by ~3-5 days.',
  );

  return {
    subject: `rpgstatus weekly: ${recent.length} session${recent.length === 1 ? '' : 's'} (week ending ${endDate})`,
    body: lines.join('\n'),
  };
}
