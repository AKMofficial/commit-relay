import { describe, expect, it } from 'vitest';
import type { Deps } from '../runtime/deps.ts';
import type { LogFn } from '../obs/log.ts';
import { recordDrop } from './drop.ts';
import { createMetrics } from '../obs/metrics.ts';
import { createSubrequestBudget } from '../core/subrequests.ts';

interface Line {
  level: string;
  event: string;
  fields?: Record<string, unknown>;
}

function deps(lines: Line[], dropWindowMs = 300_000): { deps: Deps; advance: (ms: number) => void } {
  let now = 1_000;
  const metrics = createMetrics(dropWindowMs);
  const log: LogFn = (level, event, fields) => void lines.push({ level, event, fields });
  return {
    advance: (ms: number) => void (now += ms),
    deps: {
      fetchImpl: () => Promise.reject(new Error('no fetch')),
      sleep: () => Promise.resolve(),
      log,
      metrics,
      now: () => now,
      config: {} as Deps['config'],
      subrequests: createSubrequestBudget(0),
    },
  };
}

describe('recordDrop', () => {
  it('logs jobs_dropped once per window with the window count', () => {
    const lines: Line[] = [];
    const { deps: d } = deps(lines);

    recordDrop(d, 'message_dropped', { repo: 'your-org/your-repo', sha: 'abc' });
    recordDrop(d, 'message_dropped', { repo: 'your-org/your-repo', sha: 'def' });
    recordDrop(d, 'message_dropped', { repo: 'your-org/your-repo', sha: 'ghi' });

    expect(lines.filter((l) => l.event === 'message_dropped')).toHaveLength(3);
    const collapsed = lines.filter((l) => l.event === 'jobs_dropped');
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]?.fields).toMatchObject({ count: 1 });
    expect(d.metrics.snapshot().droppedTotal).toBe(3);
  });

  it('opens a new jobs_dropped window after DROP_ALERT_WINDOW_MS', () => {
    const lines: Line[] = [];
    const { deps: d, advance } = deps(lines, 300_000);

    recordDrop(d, 'message_dropped', { repo: 'your-org/your-repo' });
    advance(301_001);
    recordDrop(d, 'message_dropped', { repo: 'your-org/your-repo' });

    const collapsed = lines.filter((l) => l.event === 'jobs_dropped');
    expect(collapsed).toHaveLength(2);
    expect(collapsed[0]?.fields).toMatchObject({ count: 1 });
    expect(collapsed[1]?.fields).toMatchObject({ count: 1 });
  });
});
