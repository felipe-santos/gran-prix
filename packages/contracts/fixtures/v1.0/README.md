# Frozen v1.0 fixtures

Byte-for-byte copies of `fixtures/valid`, `fixtures/invalid` and `schemas/` as shipped with contracts v1.0
(`@gran-prix/contracts` commit `95bdf43`). They are NEVER regenerated: `test/compat-v1.0.test.ts` proves that
every document here still validates (or still fails with the same issue) under the current contracts, and that
the current schemas are structurally a superset of the frozen ones.
