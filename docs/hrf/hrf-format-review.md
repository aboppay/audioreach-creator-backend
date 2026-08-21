<!--
Copyright (c) Qualcomm Technologies, Inc. and/or its subsidiaries.
SPDX-License-Identifier: BSD-3-Clause
-->

# HRF Format Review

**Date:** August 2026  
**Reviewers:** — (fill in)  
**Documents compared:**
- `docs/hrf/hrf-design-aug.md` — backend DB → JSON export/import design
- `docs/hrf/json-output-format.md` — XML → JSON converter output guide

---

## Background

These two documents describe different tools with different sources, but both aim to be a "human-readable format" for ACDB data. Understanding the gaps and differences between them is important before either is implemented, so that the team converges on one coherent format rather than two incompatible ones.

| | `hrf-design-aug.md` | `json-output-format.md` |
|--|--|--|
| Source data | Creator backend SQLite DB (populated from binary ACDB + AWSP) | ACDB XML format (XML-based tooling) |
| Scope | Full round-trip: export + import with API endpoints | Export only; a field-by-field reader guide |

---

## 1. What's Missing?

Issues that are present in one document but absent in the other, or absent from both.

---

### 1.1 Missing from `hrf-design-aug.md`

**M1 — Per-usecase SGKV context**

`json-output-format.md` places `sgkv` on each usecase → subgraph reference:
```json
// usecase.json
{ "subgraphs": [{ "name": "Speaker", "ref": "...", "sgkv": "DeviceRX:Speaker" }] }
```
This captures that the *same subgraph can have a different SGKV when referenced from different usecases* — which is semantically correct. `hrf-design-aug.md` puts SGKV only inside `subgraph.json`, which loses this per-usecase context entirely.

**Action required:** Decide where SGKV lives. If SGKV is a property of the subgraph globally (same for all usecases), `subgraph.json` is correct. If SGKV can differ per usecase, it must move to the usecase → subgraph reference.

---

**M2 — Hardware acceleration data (`hw_accel.json`)**

`json-output-format.md` produces `calibration/hw_accel.json` — a flat list of which parameters on which module instance are hardware-accelerated. This data exists in the DB but `hrf-design-aug.md` does not mention it.

If it exists in the DB, it must be in HRF for lossless round-trip (FR-02).

---

**M3 — GUI/authoring tool state (`qwsp/`)**

`json-output-format.md` includes `workspace/qwsp/gui_data.json`, `alsa_export.json`, and `validation_config.json` — canvas layout, merge/review history, ALSA export config. These are authoring-tool concerns.

`hrf-design-aug.md` does not include this, and it is not in the DB schema reviewed. **Confirm:** is this data stored in the creator backend DB, or only in the XML-based tool? If not in the DB, it is not a gap. If it is in the DB (e.g., under `validation_preferences` schema), it needs to be in HRF.

---

**M4 — Format version on every file, not just `metadata.json`**

`hrf-design-aug.md` puts `hrfVersion: "1.0"` only in `metadata.json`. If files are extracted from a ZIP individually (e.g., a user diffs one subgraph file directly), there is no way to know which HRF version that file conforms to.

Consider: either add `"hrfVersion": "1.0"` to every top-level JSON file, or define a `manifest.json` that lists all files with their content hashes (also useful for partial imports).

---

**M5 — Explicit `null` / optional field policy**

Neither document states what happens for optional fields that have no value: are they emitted as `null`, omitted entirely, or emitted as empty array/object? For deterministic output (FR-03), this must be specified. Example: if a module has no properties, is `"properties": []` emitted or is the `properties` key absent?

---

**M6 — `isReadonly` flag on modules and subgraphs**

The old `hrf-design.md` (commit `ef1c833f`) explicitly included `is_readonly` on modules. `hrf-design-aug.md` does not mention it. The DB schema has `subgraphs.is_exported` but there may also be a readonly flag. Confirm whether this field exists and needs to be in HRF.

---

### 1.2 Missing from `json-output-format.md`

**M7 — `subgraphPairs`**

`hrf-design-aug.md` includes `subgraphPairs` in `usecase.json` — the ordered (source, destination) subgraph pairs that define the usecase's internal routing topology. `json-output-format.md` only lists which subgraphs a usecase uses, not their pair relationships. Without this, the usecase's graph structure is incomplete.

---

**M8 — `module-manager.json` (CAPI registration)**

`hrf-design-aug.md` includes `module-manager.json` — the CAPI registration table that maps module definitions to their shared library files (`moduleType`, `interfaceType`, `interfaceVersion`, `fileName`, `tag`). This is required for lossless round-trip. `json-output-format.md` does not include it.

---

**M9 — VCPM instance calibration**

`hrf-design-aug.md` explicitly covers VCPM instance calibration inside `subgraph.json` (`vcpmInstances[].calibration`). `json-output-format.md` mentions `vcpm_modules/` in workspace definitions but does not describe where VCPM *instance* calibration values live in the output.

---

**M10 — Import path (unidirectional document)**

`json-output-format.md` is export-only. There is no description of how the JSON is imported back, how names are resolved to IDs, or what happens on error. This is not a gap in the *format* itself, but means any round-trip use of that format requires separately designed import logic.

---

**M11 — Determinism / sort order specification**

`json-output-format.md` states that names are deterministic (same input → same name) but does not specify sort order for arrays. Without an explicit sort order, two independently-written converters can produce differently-ordered files that are semantically identical but fail a byte-level diff test.

---

**M12 — `isEc` flag on data links**

`hrf-design-aug.md` includes `isEc` on data links (from `ui-metadata.json` parsing). `json-output-format.md` does not mention this field. If links in the XML source also carry this flag, it is missing.

---

## 2. What Can Be Improved?

Issues where both documents have coverage but the approach can be refined.

---

### 2.1 SGKV placement — subgraph file vs usecase reference

**Current state:**
- `hrf-design-aug.md`: SGKV in `subgraph.json` — one SGKV set per subgraph globally
- `json-output-format.md`: SGKV on the usecase → subgraph reference — per (usecase, subgraph) pairing

**The problem with `hrf-design-aug.md`:** If the same subgraph is used by two usecases with different SGKVs, the format cannot represent this. The SGKV is a property of how a usecase *uses* a subgraph, not an intrinsic property of the subgraph.

**Recommendation:** Move `sgkv` to the subgraph reference in `usecase.json`, consistent with `json-output-format.md`. Remove `sgkv` from `subgraph.json` (or keep it as a supplementary default). Update the DB mapping to clarify where `use_case_subgraphs` carries the SGKV.

---

### 2.2 Module naming — alias vs topological rank

**Current state:**
- `hrf-design-aug.md`: always `<definitionName>_<topologicalRank>` — alias is informational only
- `json-output-format.md`: `alias` if present, else `<TypeName>_<N>` positional counter

**The problem with `hrf-design-aug.md`:** Topological rank is deterministic but opaque. `MODULE_FRAMEWORK_CORE_1` tells an engineer nothing about the module's role. When an alias like `"MainDecoder"` exists, it should be the stable key — it is more readable and more stable than a rank that changes if the graph is reordered.

**The problem with `json-output-format.md`:** Counter gaps (`Data_Logging_1`, `MyLogger`, `Data_Logging_3`) are confusing. A user editing the file sees `_3` and wonders what happened to `_2`.

**Recommendation:** Use `alias` as the primary stable key when present and unique within the subgraph. Use `<definitionName>_<topologicalRank>` only when no alias exists or aliases are not unique. Eliminate counter gaps — if the alias is present, it is used as-is; if absent, the numbering is purely from topological sort and has no gaps.

---

### 2.3 Calibration tree — co-located vs separate

**Current state:**
- `hrf-design-aug.md`: `subgraphs/<sg>/modules/<key>.json` — calibration next to structure
- `json-output-format.md`: `calibration/<sg>/<module>.json` — separate tree that mirrors `usecases/subgraphs/`

**Tradeoffs:**

| | Co-located (`hrf-design-aug.md`) | Separate tree (`json-output-format.md`) |
|--|--|--|
| Finding "what does this module do + what are its values" | One folder | Two folders |
| Diffing only calibration changes | Shows subgraph dirs too | Clean `calibration/` folder diff |
| Parallel structure drift (structure renamed, calibration not) | Impossible — same folder | Possible — two trees can diverge |
| Araxis folder diff for calibration-only reviews | Mixed with structure | Clean, dedicated tree |

**Recommendation:** Keep co-located (hrf-design-aug approach). The parallel-tree problem (two trees that can diverge) in `json-output-format.md` is a real maintenance risk. Engineers reviewing calibration-only diffs can filter by `subgraphs/*/modules/` in their diff tool.

---

### 2.4 CKV representation — string vs structured array

**Current state:**
- `hrf-design-aug.md`: `"keys": [{"key": "StreamType", "value": "DEFAULT"}]` — structured array
- `json-output-format.md`: `"ckv": "DeviceRX:Speaker"` — freeform string

**The problem with freeform string:** Colon and comma separators must be escaped or avoided in key/value names. Parsing requires splitting on `:` and `,` which breaks for key names that contain those characters. The structured array is unambiguous and does not require a custom parser.

**Recommendation:** Keep the structured array from `hrf-design-aug.md`. The string form is acceptable for display but not for a machine-parseable interchange format.

---

### 2.5 Calibration parameter representation

**Current state:**
- `hrf-design-aug.md`: `{"name": "PARAM_ID_...", "paramId": 134217729, "payload": {"field": value}}`
- `json-output-format.md`: `{"PARAM_ID_...": {"value": "0dB", "hex": "0x2000"}}`

**Issues with `json-output-format.md`:**
- Dual representation (`value` + `hex`) can be inconsistent if they disagree
- No `paramId` — relies entirely on name uniqueness for import resolution
- Map-keyed-by-name means parameter order is unstable across JSON serializers

**Issues with `hrf-design-aug.md`:**
- `paramId` alongside `name` is redundant for human readers
- The `payload` object nesting adds one level of indentation

**Recommendation:** Keep `hrf-design-aug.md`'s structure. Drop `paramId` from the human-visible representation and make it a supplementary field (same treatment as `instanceId`). The `name` is the human key; the `paramId` is preserved for lossless round-trip but visually deemphasized (e.g., `"_paramId": 134217729`).

---

### 2.6 Container identification — hex ID vs semantic type

**Current state:**
- `hrf-design-aug.md`: `"containerType": "WCD_RD_MACRO"` + `"containerId": 1` (integer)
- `json-output-format.md`: `"name": "0xE0000002"` — hex ID is the name

**`json-output-format.md`'s approach** acknowledges that containers have no readable name in the source data — the hex ID is the ground truth. `hrf-design-aug.md` uses `containerType` (the type name) but that is not unique across multiple container instances of the same type.

**Recommendation:** `hrf-design-aug.md` should use a stable alias for container identification. If the DB stores a readable alias for containers, use it. If not, define a derived alias as `<containerType>_<N>` (sorted by `containerId` ASC), so containers are named `WCD_RD_MACRO_1`, `APM_GENERIC_1`, etc. — more readable than hex IDs, still deterministic.

---

### 2.7 Subsystem representation — flat list vs nested tree

**Current state:**
- `hrf-design-aug.md`: flat list with `parent` reference — hierarchy is implied
- `json-output-format.md`: nested `children[]` inside `usecases/subsystems/<name>.json` — hierarchy is explicit

**Flat list** is more diff-friendly: adding a child subsystem adds one entry, not a modification to the parent's `children[]`. However, the hierarchy is not immediately visible without parsing all entries.

**Nested tree** makes the hierarchy immediately visible but causes the parent file to be modified whenever a child is added or removed.

**Recommendation:** Keep flat list (hrf-design-aug approach) for diff stability, but add an explicit `children` array as a supplementary/computed field for readability. On import, the `parent` reference is authoritative; `children` is ignored.

---

### 2.8 Definitions: flat files vs processor-grouped directories

**Current state:**
- `hrf-design-aug.md`: `definitions/spf-modules.json` — all SPF definitions in one file
- `json-output-format.md`: `workspace/definitions/spf_modules/ADSP/*.json`, `workspace/definitions/spf_modules/cDSP/*.json` — split by processor, one file per module

**One file per module** in `json-output-format.md`:
- Better for Araxis diff at module-definition level
- A changed parameter schema shows in one file

**One file for all** in `hrf-design-aug.md`:
- Simpler structure (fewer files)
- Definition changes are less frequent than calibration changes — having them in one file is less important for diff granularity

**Recommendation:** Split `definitions/spf-modules.json` into per-processor subdirectories if definition files are large (e.g., `definitions/spf-modules/ADSP/PCM_DECODER.json`). If there are fewer than ~30 total module definitions, keeping them in one file is acceptable. Decide based on actual data volume.

---

### 2.9 Missing `createMethod` / `PL` fields on usecases

`json-output-format.md` includes `createMethod` and `PL` (pipeline?) on usecase entries. `hrf-design-aug.md` only has `type`. If `createMethod` and `PL` exist in the DB, they should be in HRF.

---

### 2.10 No schema validation spec for import

`hrf-design-aug.md` describes the import orchestrator but does not define a JSON Schema (or Zod schema) for each file type. Without a formal schema, import error messages will be vague and inconsistent. Each file type should have a corresponding Zod schema in the codebase, and those schemas should be referenced in the design doc.

---

## Summary Table

| ID | Issue | Affects | Priority |
|----|-------|---------|----------|
| M1 | SGKV placement — per-usecase vs per-subgraph | Format correctness | **High** |
| M2 | `hw_accel.json` missing from `hrf-design-aug.md` | Round-trip fidelity | **High** if in DB |
| M3 | GUI/qwsp state — confirm if in DB | Round-trip fidelity | **Medium** |
| M4 | Format version only in `metadata.json` | Tooling robustness | **Low** |
| M5 | No null/optional field policy | Determinism (FR-03) | **High** |
| M6 | `isReadonly` flag unclear | Round-trip fidelity | **Medium** |
| M7 | `subgraphPairs` missing from `json-output-format.md` | Usecase completeness | **High** |
| M8 | `module-manager.json` missing from `json-output-format.md` | Round-trip fidelity | **High** |
| M9 | VCPM instance calibration not covered in `json-output-format.md` | Data completeness | **High** |
| M10 | `json-output-format.md` has no import design | Usability | **High** |
| M11 | No sort order spec in `json-output-format.md` | Determinism | **High** |
| M12 | `isEc` missing from `json-output-format.md` | Data completeness | **Medium** |
| I1 | SGKV should move to usecase → subgraph reference | Format correctness | **High** |
| I2 | Alias as primary key when available | Readability | **Medium** |
| I3 | Calibration co-located is better (keep `hrf-design-aug.md` approach) | Maintainability | **Low** (confirmed) |
| I4 | CKV structured array is better than string | Parsability | **Medium** (confirmed) |
| I5 | `paramId` should be supplementary, not primary | Readability | **Low** |
| I6 | Container alias derivation needed (`WCD_RD_MACRO_1`) | Readability | **Medium** |
| I7 | Subsystem flat list is better; add supplementary `children` for readability | Clarity | **Low** |
| I8 | Consider splitting `definitions/spf-modules.json` by processor | Diff granularity | **Low** |
| I9 | `createMethod` / `PL` on usecases — confirm if in DB | Data completeness | **Medium** |
| I10 | Formal JSON/Zod schema per file type not specified | Import robustness | **Medium** |
