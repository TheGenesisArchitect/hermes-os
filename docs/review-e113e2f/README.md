# Per-finding review fragments — `6370577..e113e2f`

Six paste-sized patches, one per finding. Full diff: `../e113e2f-review.patch`
(1,132 lines). Suite: **65/65**. Live kill: **ENGAGED** — no capital has
touched any of this.

| # | file | lines | finding | the question to answer |
|---|---|---:|---|---|
| 1 | `P1-1-decoy-fallback.patch` | 37 | decoy fallback published derived USD | does an untrusted pool now publish MEASURED quote depth (~$5) instead of the derived $91M? |
| 2 | `P1-2-observation-binding.patch` | 50 | band was a filter, not a trust boundary | does admission consume the SAME observation that selected the pool, with the trust flag travelling alongside? |
| 3 | `P1-3-and-P2-manifest.patch` | 121 | corrupt manifest wedged the lane · R5 null≡zero | does `validateManifest` reject `{version,genomes,elite:{},filler:{}}`? is R5 now strict measured-zero? |
| 4 | `PASSHEALTH-counter.patch` | 111 | release requirement | is the alert edge-triggered (one row per transition, not per failure)? |
| 5 | `PAPER-lane-parity.patch` | 61 | sensor-lane parity | do R2/R5 carry the same semantics in paper as in live? |
| 6 | `TESTS-and-widened-windows.patch` | 148 | **the reviewer's stated priority** | see below |

## On fragment 6 — the widened assertion windows

Three windows grew (1600→2800, 1800→2800, 900→1600). My claim: each still
brackets the same executable gate, and the growth is comment volume from the
P1-2 rewrite. The gate spans ~61 source lines:

```
line 11   if (cfg.FORMULA_MANIFEST_ENABLED) {   <- anchor
line 43     if (v.kind === "refuse") {
line 44       await audit("live_buy_skipped", …) <- asserted
line 45       return;                             <- asserted
line 61   }                                       <- gate closes
```

**Verify rather than accept.** And the honest limitation: these are
source-TEXT assertions — they prove a string appears near an anchor, not that
the call executes. The behavioural coverage for the same properties lives in
the pure-function tests in the same fragment (`manifestVerdict`,
`validateManifest`, `fetchTokenMarket` with a stubbed fetch). If you judge the
text assertions too weak to certify, the behavioural set should carry the
verdict.

## Known gaps (not discovered — disclosed)

- No behavioural test that a corrupt manifest leaves the OLD lane trading;
  only that the verdict returns `refuse` instead of throwing.
- `pass_inert` / `pass_recovered` has no unit test — read-only-verifiable.
- Admission-court evidence remains in-sample; the out-of-sample test is the
  10-seat sample run itself.
