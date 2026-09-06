// `vite` is a transitive dependency of vitest and is not hoisted, so `vite/client`
// is unreachable from `types`. tests/invariants.test.ts needs only `import.meta.glob`.
interface ImportMeta {
  glob(
    pattern: string,
    options: { query: string; import: string; eager: true },
  ): Record<string, unknown>;
}
