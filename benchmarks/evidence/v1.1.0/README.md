# v1.1.0 sanitized evidence

All files here are derived from the maintainer's local measurements on 2026-11-08..11. They are aggregates, not a unified benchmark: binaries, fixtures and ports differed. Private absolute paths, session IDs, prompts, tokens and raw logs are removed.

- `engine-deferred-neighbor.json` - predecessor fill and full-query gate.
- `engine-tool-envelope.json` - malformed tool-call envelope fix.
- `rk4v4-gdn32.json` - RK4V4/GDN FP32 fidelity, long pins, 190K, regression and VRAM.
- `state-card-5x.json` - five-run multi-file refactor A/B.
- `pruner-fixture.json` - deterministic pruner fixture plus model-level caveats.

The patches in `benchmarks/qualification/` are the source of record for the two engine changes. See `docs/QUALITY_FIDELITY_V1.1.0.md` for interpretation and limitations.
