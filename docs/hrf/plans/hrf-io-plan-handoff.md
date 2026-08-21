# Plan Handoff: HRF Upload / Download / Compare

**Spec:** `docs/hrf/design/hrf-io-design.md`
**Plan output:** `docs/hrf/plans/hrf-io.md`
**Scope note:** All 7 chapters from the spec's "Notes on sequencing" section are in scope.
Planning only — no code implementation. The comparison *feature* is out of scope; only its
enabling hooks (§2.7) are planned in Ch6.

## Chapter → spec-section map

| Chapter | Spec sections | Summary |
|---|---|---|
| Ch1 ParsedProject seam + ACDB refactor | §2.1, §2.2 | Formalize `ParsedProject` contract; refactor ACDB parser/orchestrator to emit/consume it (backward-compatible; ACDB tests stay green) |
| Ch2 HRF param codec adapters | §2.5 | `hrf-param-encoder` (readable→binary, enum-label→value + fallback) and `hrf-param-decoder` (binary→readable, valueName from rangeList) wrapping existing `serialize/parseParameterData` |
| Ch3 Calibration encode/decode worker handlers | §2.6, §2.6.1 | `ENCODE_CAL_PAYLOADS`/`DECODE_CAL_PAYLOADS` handlers + registry wiring, cpus-1 chunking helper, per-worker `convertParamDefinition` cache, `isThreadingSupported` sequential fallback, worker-vs-sequential parity |
| Ch4 Upload-HRF pipeline | §2.3 | `hrf-archive-reader` (stream unzip) + `hrf-parser` (walk → ParsedProject, cross-link by name, parallel encode); controller format dispatch; feed existing UploadFileOrchestrator; integration parity vs ACDB |
| Ch5 Download-HRF pipeline | §2.4 | `hrf-serializer` (DownloadEntities → HRF tree, parallel decode, subgraph dedup with {name,ref,sgkv}) + `hrf-archive-writer` (stream zip); controller format discriminator |
| Ch6 Round-trip, KPI, comparison hooks | §2.7, Verification | Byte-identical round-trip golden test (ACDB→HRF→ACDB); KPI benchmark (≤10s, no ACDB regression); comparison-hook smoke (load two files via readAllEntitiesForFile, diff by hex ID) |

## Batches

### Batch 1 (parallel)
- **Ch1 ParsedProject seam + ACDB refactor** | Sections §2.1–§2.2 | Start task 1
- **Ch2 HRF param codec adapters** | Section §2.5 | Start task 7

### Batch 2 (after batch 1 — needs Ch2 adapter types)
- **Ch3 Calibration encode/decode worker handlers** | Sections §2.6–§2.6.1 | Start task 13

### Batch 3 (parallel, after batch 2 — need Ch1 seam + Ch3 handlers)
- **Ch4 Upload-HRF pipeline** | Section §2.3 | Start task 19
- **Ch5 Download-HRF pipeline** | Section §2.4 | Start task 27

### Batch 4 (after batch 3 — needs Ch4 + Ch5)
- **Ch6 Round-trip, KPI, comparison hooks** | Section §2.7 + Verification | Start task 34
