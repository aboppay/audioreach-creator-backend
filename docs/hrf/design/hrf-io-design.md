# HRF Upload / Download / Compare — Requirements & LLD Design

## Context

The team has defined a new **HRF** file format (docs/ACDB2JSON/) — a human-readable JSON
directory tree (~63 MB, ~4,708 files across `usecases/`, `calibration/`, `workspace/`) that
represents the same data as the existing ACDB (binary) + AWSP (JSON) file pair. We need to:

1. **Upload HRF** — import an HRF archive into the DB.
2. **Download HRF** — export a project from the DB as an HRF archive.

And do so without forking the codebase into two parallel implementations. A **DB-backed
comparison** feature (diff two projects field-by-field, across formats) is coming next and
must be cheap on top of this design.

### Approved decisions (from brainstorming)

| Decision | Choice |
|---|---|
| DB schema | **One canonical schema.** ACDB and HRF are both serializer/deserializer lanes over the same tables. No second schema. |
| Cross-format interop | **Full round-trip both ways.** Upload HRF → download ACDB, and upload ACDB → download HRF, from the same project. |
| Transport | **Single archive (zip)** per HRF file. Client zips the tree; server streams a zip back. Reuses the existing single-file multipart pattern. |
| KPI | **Match ACDB (~10 s)** for upload and download. |
| Param round-trip fidelity | **Byte-identical.** ACDB→HRF→ACDB must reproduce identical binary payloads (verified by round-trip test). |
| Code convergence | **Option A — converge at domain entities.** HRF and ACDB parsers emit the *same* domain-entity set; the orchestrator, builders, FK mapper, inserters, read/download services, and comparison are all **one shared implementation**. Format-specific code lives only at the parse/serialize edges. |
| ACDB pipeline changes | **Permitted.** Backward-compatible refactor of the ACDB parser's output boundary is allowed to make the entity output truly shared (not a rewrite). |

### Key existing assets this design reuses (do NOT rebuild)

- **Struct-aware param codec** — `serializeParameterData()` (readable→binary) and
  `parseParameterData()` (binary→readable) in
  `packages/core/src/application/usecase-designer/shared/{serialize,parse}-elements.ts`.
  Param struct schemas (with `rangeList` enum labels) are already persisted in
  `spf_module_parameter_definitions.elements_structure`. **This is the make-or-break asset** —
  HRF's decoded calibration round-trips to the DB's binary BLOBs with trusted code.
- **Bulk insert path** — `BulkImportRepository` + `BatchInserter` (batch of 100 + per-row
  fallback) in `packages/infrastructure/persistence/.../repositories/bulk-import/`.
- **Bulk read path** — `BulkReadQueryService.readAllEntitiesForFile(fileSystemId)` loads a
  whole file's entities in parallel; returns `DownloadEntities` keyed by stable hex IDs.
- **Upload orchestration** — `UploadFileOrchestrator` + entity-builders + `ForeignKeyMapper`
  (build-insert-build, 1M ID reservation) in `upload-file/services/`.
- **Worker pool** — `WorkerPoolPort` (already used by the AWSP parser) for parallel parse/encode.
- **File I/O** — `FileSystemPort`.
- **One project = one file** — upload already collapses ACDB+AWSP into a single `files` row;
  HRF imports the same way (one archive → one project → one file).
- **Stable hex IDs** — `subgraph_id`, `instance_id`, `module_definition_id`, `key_id`,
  `container_id` are stable across files → natural comparison keys.

---

## Part 1 — Requirements

### Functional

**Upload HRF**
- FR-U1: Accept an HRF archive (`.zip`) via the upload API; validate it is a well-formed HRF
  tree (has `usecases/`, `calibration/`, `workspace/`).
- FR-U2: Parse the tree into the **shared domain-entity set** (same objects the ACDB parser
  produces), resolving HRF's readable calibration/property values **back to binary payloads**
  via the existing param codec.
- FR-U3: Persist via the existing `BulkImportRepository`. One archive → one project → one file.
- FR-U4: Continue-on-error semantics with per-entity issue collection, identical to ACDB upload
  (partial success + issue report returned to client).
- FR-U5: Resolve enum labels (`"Low Latency"` / `valueName`) back to raw values during encoding;
  fall back to the raw `hex`/`value` when a label is absent.

**Download HRF**
- FR-D1: Given a `projectId`, load the file's entities via `BulkReadQueryService` (shared read
  path) and serialize to the HRF tree.
- FR-D2: **Decode** binary calibration/property payloads into HRF's readable form via
  `parseParameterData()`, including enum-label (`valueName`) resolution from `rangeList`.
- FR-D3: Deduplicate shared subgraphs (write once under `usecases/subgraphs/`, reference by
  `{name, ref, sgkv}` pointer) — matches the HRF spec.
- FR-D4: Stream the result to the client as a single `.zip`.

**Round-trip & fidelity**
- FR-R1: ACDB upload → HRF download → HRF upload → ACDB download yields **byte-identical**
  binary payloads for every parameter/property.
- FR-R2: Every hex ID is preserved verbatim across the round-trip (never recomputed).

**Comparison (forward-looking hooks — full feature is a separate plan)**
- FR-C1: The read path must expose two projects' entities keyed by stable hex IDs so a
  field-level diff can be computed without format-specific logic.
- FR-C2: Comparison must be format-agnostic (works whether each side was imported from ACDB or
  HRF), because both land in the same canonical schema.

### Non-Functional
- NFR-1: Upload-HRF and download-HRF each ≤ ~10 s for a representative config (~63 MB / ~4,708
  files). Encode/decode of calibration is the dominant cost — must be parallelized.
- NFR-2: Memory bounded — stream the zip; do not hold all 4,708 parsed files + the full
  entity graph + serialized output simultaneously at peak.
- NFR-3: **Single API implementation** — one controller path and one CQRS handler family
  dispatch on file type at the edges; no duplicated ACDB-vs-HRF business logic.
- NFR-4: No regression to the shipped ACDB upload/download KPI when refactoring its parser's
  output boundary to the shared entity set.

### Out of scope (this plan)
- The full comparison UI/endpoint/diff-result model (separate plan; only the enabling hooks
  are in scope here).
- Three-way merge / conflict resolution.
- HRF schema versioning/migration.

### Open questions to resolve during implementation
- OQ-1: Exact zip library (stream-capable) — pick one already in the dependency tree if present.
- OQ-2: Whether enum-label→value resolution belongs *inside* `serialize/parse-elements.ts`
  (shared) or in an HRF-adapter wrapper. Recommendation below (adapter wrapper) keeps the codec
  format-neutral.

---

## Part 2 — LLD Design

### 2.1 Architecture — convergence at domain entities

```
 upload:                                          download:
   .acdb+.awsp --> AcdbParser --\                /-- AcdbSerializer --> .acdb+.awsp
                                 >-[ Domain      -<
   .hrf.zip     --> HrfParser  --/   Entities ]   \-- HrfSerializer  --> .hrf.zip
                                        |  ^
                                        v  |
                                 BulkImport  BulkRead
                                        |  |
                                   [ ONE canonical DB ]
                                        |
                                   Comparison (hex-keyed, format-agnostic)
```

- **Parse/serialize edges are the ONLY format-specific code.** Everything from domain entities
  inward is shared and already exists.
- Domain entities = the objects produced by
  `packages/core/src/application/file-operations/upload-file/services/entity-builders/*` and
  consumed by `BulkImportRepository`. HRF's parser targets this exact set.

### 2.2 Shared entity boundary (the refactor)

Today the ACDB parse → entity build is somewhat intertwined in `AcdbFileOrchestrator` /
`UploadFileOrchestrator`. To make Option A real:

1. Define a stable **`ParsedProject` domain-entity contract** (the union of builder inputs:
   subgraphs, containers, spf-modules, data/control links, use-cases, key/tag/module
   definitions, calibration payloads, properties) — this likely already exists implicitly as the
   builders' input types; formalize it as a named boundary type in `core`.
2. Refactor the ACDB path so `AcdbParser` emits `ParsedProject`, and the orchestrator consumes
   `ParsedProject` (format-agnostic). **Backward-compatible** — same entities, just a named seam.
3. `HrfParser` implements the same output contract.

Files: new `file-operations/shared/parsed-project.ts` (contract); refactor
`upload-file/services/acdb-file-orchestrator.ts` + `upload-file-orchestrator.ts` to the seam.

### 2.3 Upload-HRF pipeline

New: `packages/core/src/application/file-operations/upload-file/services/hrf/`
- `hrf-archive-reader.ts` — stream-unzip; yield entries by logical section without buffering all.
- `hrf-parser.ts` — walk `usecases/`, `calibration/`, `workspace/`; build `ParsedProject`.
  - Cross-links by name (calibration folder name == subgraph file name) per HRF spec.
  - Resolves readable calibration → binary via **`hrf-param-encoder.ts`** (adapter around
    `serializeParameterData()`), doing enum-label→value resolution first (FR-U5), then encode.
- Feeds the **existing** `UploadFileOrchestrator` → `BulkImportRepository`. No new insert code.

Controller: extend the existing upload endpoint (or add a sibling) in
`packages/api/src/presentation/rest/modules/project/project.controller.ts` to detect `.zip`/HRF
and dispatch `UploadFileCommand` with a `format` discriminator. **One handler family.**

### 2.4 Download-HRF pipeline

New: `packages/core/src/application/file-operations/download-file/services/hrf/`
- `hrf-serializer.ts` — consume `DownloadEntities` from the **existing**
  `BulkReadQueryService.readAllEntitiesForFile()`; emit the HRF tree structure.
  - Decodes binary payloads → readable via **`hrf-param-decoder.ts`** (adapter around
    `parseParameterData()`), resolving `valueName` from `rangeList` (FR-D2).
  - Dedups shared subgraphs to `usecases/subgraphs/` with `{name, ref, sgkv}` pointers (FR-D3).
- `hrf-archive-writer.ts` — stream entries into a `.zip` response (FR-D4, NFR-2).

Controller: extend the existing download endpoint to accept a `format=hrf` (or `Accept`)
discriminator and dispatch the query with the HRF serializer selected. **One handler family.**

### 2.5 Param codec adapters (the round-trip core)

- `hrf-param-encoder.ts`: `(readableParamJson, paramDefinition) -> Uint8Array`
  - Map enum label/`valueName` → raw value using `rangeList`; fall back to `hex`/`value`.
  - Call existing `serializeParameterData(def, elements)`.
- `hrf-param-decoder.ts`: `(payload, paramDefinition) -> readableParamJson`
  - Call existing `parseParameterData(payload, def.elementsStructure)`.
  - Attach `valueName` by reverse-looking-up `rangeList`.
- Keep the base codec (`serialize/parse-elements.ts`) **format-neutral**; label resolution
  lives in these adapters (OQ-2 recommendation).

### 2.6 Performance design (hitting ~10 s)

Format-intrinsic costs (exist in all designs, not caused by sharing entities):
- **Parse**: unzip + `JSON.parse` ~63 MB / 4,708 files.
- **Encode/decode calibration**: dominant cost — DB is binary, HRF is decoded.

Levers (all reuse existing infra):
1. **Parallelize** parse + encode across `WorkerPoolPort` — files are embarrassingly parallel.
2. **Cache `convertParamDefinition(elements_structure)` per parameter definition** — parse each
   param schema once, reuse across all instances. Highest-leverage optimization for encode.
3. **Reuse tuned `BatchInserter`** (batch 100 + fallback) — unchanged.
4. **Stream** the zip on both ends — bound memory (NFR-2).

Stage budget (to validate, upload-HRF): unzip+parse ≤ ~3 s ‖ encode calibration ≤ ~4 s (parallel)
‖ bulk insert ≤ ~3 s. **Benchmark the encode step first** — it's the KPI risk.

#### 2.6.1 Parallelizing `elements[] → Uint8Array` calibration encoding (detail)

**Why it needs real threads.** `serializeParameterData()` (serialize-elements.ts:34) is a
**synchronous, CPU-bound** function (recursive struct/array walk + `BinaryDataWriter`). Wrapping
it in `Promise.all` on the main thread gives **no** speedup — Node's event loop is single-
threaded, so CPU-bound sync work runs serially regardless. Real parallelism requires the
**worker pool** (`WorkerPoolPort`, node-worker-pool.adapter.ts — pool size = `cpus-1`). The AWSP
parser already does exactly this via `handlerKey`-dispatched tasks (awsp-parser.ts:389 is the
template to copy).

**Pool capability — no changes needed.** Verified against node-worker-pool.adapter.ts: the pool
uses real `node:worker_threads` (a pool of `cpus-1` OS-backed threads created at construction,
adapter.ts:91–139), so it delivers **genuine multi-core parallelism**, not event-loop
concurrency. `executeParallel` dispatches across available workers and queues any excess
(adapter.ts:62–72, 146). We therefore add only a new **task handler**, not any pool changes.
Three usage constraints the adapter imposes that our design must honor:
- **Concurrency cap = pool size** (`cpus-1`); tasks beyond it queue. → partition into exactly
  `cpus-1` chunks, one task per chunk (full utilization, no queue overhead).
- **30 s per-task timeout** (adapter.ts:14, 226) — a task exceeding it *rejects*. Coarse chunks
  finish far under this (~4 s spread across workers), but keep chunks bounded; timeout is
  constructor-configurable if ever needed.
- **`executeParallel` = `Promise.all`** (adapter.ts:69): an *infrastructure* failure (timeout /
  worker crash) rejects the whole batch, but a *business* failure (a param that won't encode)
  must be **caught inside the handler and returned as `WorkerResult{success:false}` data** — this
  is what preserves continue-on-error → `IssueCollector` (FR-U4). Handlers must never throw on a
  single bad payload.
- *Optional future optimization (non-blocking):* `postMessage` clones without a transfer list, so
  returned `Uint8Array`s are copied. Adding `transferList` support to the port would make it
  zero-copy — note it, but it is not required to hit the KPI.

**What crosses the worker boundary (structured-clone-safe only).** Both `serializeParameterData`
and `convertParamDefinition` are pure and safe *except* the `logger` argument — **drop the logger
at the boundary** (it won't clone). Per payload we send only primitives/plain objects:
- `elementsStructure: string` (the param definition JSON — already contains `rangeList` enum
  labels, so enum-label→value resolution can happen inside the worker), and
- `readableElements` (the HRF decoded param JSON, plain object), plus
- correlation keys: `{ moduleInstanceId, ckvKey|tkvKey, parameterId }`.
Worker returns `{ ...keys, payload: Uint8Array }` (or `{ ...keys, error }`). `Uint8Array` clones
fine (ideally transferred).

**New worker handler.** Register `ENCODE_CAL_PAYLOADS` in the same registry the parser handlers
use (mirrors `HANDLER_KEYS.PARSE_DEFINITION`; loaded by `generic.worker.ts`). Handler body:
```
encodeCalPayloads(input: { items: EncodeItem[] }): { results: EncodedItem[] } {
  const defCache = new Map<string, DefinitionElement[]>();   // per-worker, per-batch
  for (const it of input.items) {
    let def = defCache.get(it.elementsStructure);
    if (!def) { def = convertParamDefinition(it.elementsStructure); defCache.set(...); }
    // 1) resolve enum label / valueName -> raw value using def's rangeList (FR-U5)
    // 2) const r = serializeParameterData({ elementsStructure: it.elementsStructure, ... },
    //                                     mappedElements /* no logger */);
    // 3) push { keys, payload } or { keys, error }
  }
}
```

**Work partitioning.** The natural unit is **one payload = one (module-instance, ckv/tkv,
parameter)** tuple (calibration-data-builder.ts extracts payloads at this granularity). Flatten
the whole file's payloads into one list, then split into **`cpus-1` roughly-equal chunks** (one
`WorkerTask` per chunk — coarse-grained, so per-task overhead is amortized; do NOT create one
task per payload). Submit via `workerPool.executeParallel(tasks)`; on return, check each
`WorkerResult.success`, collect `payload`s back onto their entities by correlation key, and route
any per-item `error` into the existing `IssueCollector` (continue-on-error, FR-U4).

**The definition cache is the highest-leverage win.** A config has few *distinct* param
definitions but many *instances* (same `elementsStructure` reused across every CKV/module). Cache
`convertParamDefinition(elementsStructure)` keyed by the string so each schema is parsed once per
worker per batch. Optionally also cache on the main thread for any sequential fallback path.

**Fallback.** If `workerPool.isThreadingSupported()` is false (matches AWSP's
`shouldUseParallelParsing()` guard), run the same handler function inline sequentially — correct,
just not parallel. Keeps a single code path for the encode logic.

**Symmetry on download.** Decode (`parseParameterData`, binary→readable) is the mirror image and
parallelizes identically via an `ENCODE`-analog `DECODE_CAL_PAYLOADS` handler — same partitioning,
same per-worker def cache. Reuse the same chunking helper for both directions.

### 2.7 Comparison hooks (enable the next feature cheaply)

- Reuse `readAllEntitiesForFile(fileSystemId)` for each of the two projects.
- Diff by **stable hex IDs** (`subgraph_id`, `instance_id`, etc.) — same logical entity ⇒ same
  hex across files. No system-id remapping, no format-specific logic.
- Since both formats land in the same schema, comparison is inherently format-agnostic (FR-C2).
- No schema changes required now; just avoid decisions that would couple entities to a format.

---

## Verification

- **Unit**: `hrf-param-encoder`/`decoder` adapters — enum-label resolution + fallback; struct,
  array, nested-struct cases mirroring `serialize/parse-elements` test fixtures.
- **Round-trip (FR-R1, byte-identical)**: golden test — take an existing ACDB fixture, upload →
  download-HRF → upload-HRF → download-ACDB; assert **byte-identical** binary payloads and
  verbatim hex IDs. This is the primary correctness gate.
- **Integration**: HRF upload writes the same DB rows as the equivalent ACDB upload (assert
  parity on subgraphs, modules, ckv/tkv payloads, links, use-cases).
- **KPI**: benchmark upload-HRF and download-HRF against the ~63 MB sample; assert ≤ ~10 s;
  record stage timings; confirm no ACDB KPI regression.
- **Encode parallelism**: verify the `ENCODE_CAL_PAYLOADS` worker handler produces payloads
  byte-identical to a sequential inline run (worker path == fallback path); measure speedup vs.
  sequential and confirm the per-worker def-cache hit rate is high.
- **Memory**: peak RSS bounded during a full HRF upload/download (streaming holds).
- **Comparison smoke**: load two files via `readAllEntitiesForFile`, diff by hex ID, confirm a
  known injected change is detected (proves the hook).

## Notes on sequencing (for the implementation plan)
1. Formalize `ParsedProject` seam + refactor ACDB parser to it (no behavior change; ACDB tests green).
2. Param codec adapters + unit tests.
3. `ENCODE_CAL_PAYLOADS` / `DECODE_CAL_PAYLOADS` worker handlers + registry wiring + chunking
   helper; worker-vs-sequential parity test.
4. HRF parser + archive reader → upload path (wired to the parallel encode); integration parity tests.
5. HRF serializer + archive writer → download path (wired to the parallel decode).
6. Byte-identical round-trip test.
7. KPI benchmark + tune chunk size / def-cache.
8. Comparison hook smoke test.
