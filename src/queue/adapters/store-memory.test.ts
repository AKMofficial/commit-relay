import { describe, expect, it } from 'vitest';
import { configObject } from '../../config/schema.ts';
import { commitKey } from '../../relay/dedup.ts';
import { createMemoryDedup } from './store-memory.ts';
import { createFakeMetrics } from '../../../tests/fake-metrics.ts';

describe('createMemoryDedup', () => {
  it('holds DEDUP_MAX_ENTRIES typical commit keys without byte eviction', () => {
    const cfg = configObject.parse({
      GITHUB_WEBHOOK_SECRET: 'store-memory-test-secret-00000000000000000',
      DEDUP_MAX_ENTRIES: 20_000,
    });
    const dedup = createMemoryDedup(cfg, createFakeMetrics(), () => 1_000);
    const firstSha = (0).toString(16).padStart(40, '0');
    const firstKey = commitKey('your-org/your-repo', firstSha, '2345678', '7654321');

    for (let i = 0; i < 15_000; i += 1) {
      const sha = i.toString(16).padStart(40, '0');
      dedup.recordCommit(commitKey('your-org/your-repo', sha, '2345678', '7654321'));
    }

    expect(dedup.sizes().commits).toBe(15_000);
    expect(dedup.hasCommit(firstKey)).toBe(true);
  });
});
