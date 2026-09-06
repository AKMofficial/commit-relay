import { describe, expect, it } from 'vitest';
import {
  SubrequestBudgetExceeded,
  budgetedFetch,
  createSubrequestBudget,
} from './subrequests.ts';

describe('createSubrequestBudget', () => {
  it('debits until the limit, then refuses', () => {
    const b = createSubrequestBudget(3);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
    expect(b.remaining()).toBe(0);
  });

  it('is unlimited at limit 0', () => {
    const b = createSubrequestBudget(0);
    for (let i = 0; i < 1000; i += 1) expect(b.take()).toBe(true);
    expect(b.remaining()).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('budgetedFetch', () => {
  it('rejects with SubrequestBudgetExceeded instead of calling through', async () => {
    let calls = 0;
    const inner = (async () => {
      calls += 1;
      return new Response('ok');
    }) as unknown as typeof fetch;
    const budget = createSubrequestBudget(1);
    const f = budgetedFetch(inner, budget);

    await f('https://example.com/1');
    expect(calls).toBe(1);

    await expect(f('https://example.com/2')).rejects.toBeInstanceOf(SubrequestBudgetExceeded);
    expect(calls).toBe(1);
  });
});
