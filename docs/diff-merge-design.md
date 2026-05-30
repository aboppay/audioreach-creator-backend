<!--
Copyright (c) Qualcomm Technologies, Inc. and/or its subsidiaries.
SPDX-License-Identifier: BSD-3-Clause
-->

# ACDB Diff-Merge: Design Document

**Version:** 1.0
**Date:** May 2026
**Status:** Draft
**Audience:** Developers, Architects, Contributors

---

## Table of Contents

1. [Context & Goals](#1-context--goals)
2. [Requirements](#2-requirements)
3. [Architecture Decision Records](#3-architecture-decision-records)
4. [Data Model Changes](#4-data-model-changes)
5. [Algorithm Design](#5-algorithm-design)
6. [System Architecture](#6-system-architecture)
7. [Workflows](#7-workflows)
8. [Conflict Handling](#8-conflict-handling)
9. [Patch File Format](#9-patch-file-format)
10. [Performance Analysis](#10-performance-analysis)
11. [Testing Strategy](#11-testing-strategy)

---

## 1. Context & Goals

### 1.1 Problem Statement

AudioReach Creator manages ACDB (AudioReach Calibration Database) files that describe audio processing graphs. These files evolve over time: vendors release new reference versions, customers customize them for their hardware, and teams need to merge changes across versions.

The core challenge is that ACDB files use **file-local integer IDs** (subgraph IDs, module instance IDs) that are not stable across files. A naive byte-level or ID-level comparison is meaningless. Comparison must be **semantic** — matching entities by their audio-domain identity (usecase GKV, module definition type, graph topology).

### 1.2 Business Goals

| Goal | Description |
|------|-------------|
| **Two-Way Comparison** | Show what differs between a reference file and a target file |
| **Three-Way Merge** | Compute delta between reference and base, apply delta to target while preserving customer customizations |
| **Create Patch File** | Serialize the delta between two files into a portable, human-readable JSON file |
| **Apply Patch File** | Apply a patch file to any target file, detecting conflicts with customizations |
| **Customization Safety** | Customer-marked entities (`isReadonly`) are never deleted or modified by automated actions |

### 1.3 Scope

**In Scope:**
- Semantic comparison of ACDB files at all levels: usecases, subgraphs, modules, links, subgraph pairs
- Comparison of module definitions (SpfModuleDefinition)
- Two-way and three-way comparison modes
- Create and apply patch files (portable JSON format)
- `isReadonly` annotation at module, subgraph, and usecase level
- Conflict detection and reporting
- Integration with the existing `edit_actions` / DIFF_MERGE session framework
- Parallel comparison using the existing worker pool infrastructure
- Iteration 1: structural comparison (modules + links); property/calibration comparison in subsequent iterations

**Out of Scope:**
- UI/UX implementation details
- Binary ACDB file format changes (readonly flag stored in DB, not in binary)
- Real-time / streaming comparison
- Comparison of non-ACDB file types (.awsp workspace files)

---

## 2. Requirements

### 2.1 Functional Requirements

#### FR-1: Two-Way Comparison
**Description:** Compare a reference ACDB file against a target ACDB file and produce a set of unstaged `edit_actions` representing the changes needed to make the target match the reference.

**Acceptance Criteria:**
- Both files must be uploaded and parsed into the database before comparison
- Comparison operates on domain entities (not raw binary)
- Output is a set of unstaged `edit_actions` in the target file's DIFF_MERGE session
- Two-way comparison is a degenerate case of three-way merge where Base = Target
- User selects which actions to stage; not all actions need to be applied

#### FR-2: Three-Way Merge
**Description:** Given three files — Base (common ancestor), Reference (updated version), and Target (customer-customized version) — compute the delta (Ref − Base) and apply it to Target, respecting Target's `isReadonly` annotations.

**Acceptance Criteria:**
- All three files must be uploaded and parsed into the database
- Delta = changes made in Ref relative to Base
- Delta is applied to Target, producing unstaged `edit_actions`
- Actions that conflict with `isReadonly` entities in Target are reported as conflicts (validation errors)
- Non-conflicting actions are added as unstaged `edit_actions`
- User reviews, resolves conflicts, and stages desired actions

#### FR-3: Create Patch File
**Description:** Serialize the delta between two files (Ref − Base, or Ref − Target for two-way) into a portable, human-readable JSON patch file.

**Acceptance Criteria:**
- Patch file uses stable identifiers (GKV, subgraph fingerprint, module definition ID, graph neighborhood) — never file-local system IDs
- Patch file is human-readable JSON
- Patch file contains all operations: ADD, REMOVE, UPDATE for usecases, subgraphs, modules, links, definitions
- Patch file includes metadata (version, creation date, description)

#### FR-4: Apply Patch File
**Description:** Apply a patch file to any target ACDB file, using the same semantic matching logic to locate entities, and producing unstaged `edit_actions`.

**Acceptance Criteria:**
- Patch file operations are translated to unstaged `edit_actions` in the target's DIFF_MERGE session
- Entity location uses the same two-level graph matching algorithm (GKV → subgraph fingerprint + neighborhood → module definitionSystemId + neighborhood)
- Operations that cannot be located in the target are reported as conflicts
- Operations that conflict with `isReadonly` entities are reported as conflicts

#### FR-5: Readonly / Customization Annotations
**Description:** Customers can mark entities in their target file as `isReadonly` to protect their customizations from being overwritten by automated diff-merge actions.

**Acceptance Criteria:**
- `isReadonly` flag available at three levels: module, subgraph, usecase
- Flag is stored as a DB column on the respective entity tables
- Flag is set/cleared via API (part of the DIFF_MERGE session workflow)
- When `isReadonly = true`: no DELETE or MODIFY actions are generated for that entity
- When ref adds a new entity adjacent to a readonly entity, an ADD action is still generated (shown to user)
- `isReadonly` is only considered on the **Target** file; Base and Ref files are treated as clean vendor files

#### FR-6: Conflict Detection and Reporting
**Description:** Detect and report cases where a delta action cannot be applied to the target.

**Conflict Types:**
- **Readonly Conflict**: Delta says DELETE or MODIFY an entity, but entity is `isReadonly` in Target
- **Missing Entity Conflict**: Delta says DELETE or MODIFY an entity, but entity cannot be found in Target (e.g., customer removed it)
- **Definition Missing Conflict**: Delta says ADD a module of type X, but definition X does not exist in Target
- **Structural Conflict**: Delta says ADD a link between modules A and B, but module A or B was not found in Target

**Acceptance Criteria:**
- Conflicts are reported as validation errors in the API response
- Each conflict includes: conflict type, affected entity identity, description, suggested resolution
- Some conflicts are auto-resolvable (e.g., skip a DELETE for a missing entity); others require manual user action
- After user resolves a conflict (e.g., by marking an entity as non-readonly, or by manually adding a missing entity), the action can be re-applied

#### FR-7: Integration with edit_actions Framework
**Description:** All comparison output integrates with the existing modification framework.

**Acceptance Criteria:**
- Target file must have an active DIFF_MERGE session before comparison
- Comparison results are written as unstaged `edit_actions` to the existing `edit_actions` table
- Actions follow the existing `CHANGE_OPERATION` vocabulary: CREATE, UPDATE, DELETE
- Actions are ordered: DELETE first, then UPDATE, then ADD (dependency-safe)
- User uses existing stage/commit workflow to apply selected actions

#### FR-8: Parallel Comparison
**Description:** Comparison of large files (1000–1500 usecases) must be parallelized.

**Acceptance Criteria:**
- Usecase-level comparison is embarrassingly parallel (each usecase pair is independent)
- Worker pool (existing `IWorkerPool` infrastructure) is used to distribute usecase batches across threads
- Voting aggregation is performed after all workers complete
- Parallel execution must not affect correctness of the final mapping

#### FR-9: Definitions Comparison
**Description:** Compare `SpfModuleDefinition` entities between files.

**Acceptance Criteria:**
- Definitions are matched by `definitionSystemId` (stable across files)
- Definitions present in Ref but not in Target → ADD action (and potential conflict if modules of that type are being added)
- Definitions present in Target but not in Ref → no action by default (Target has extra definitions)
- Definition changes (property updates) → UPDATE action

---

### 2.2 Non-Functional Requirements

#### NFR-1: Performance
- Total comparison time for a typical file (1500 usecases, 3–5 SGs/UC, 3–10 modules/SG): **< 10 seconds**
- Patch file creation: **< 2 seconds** after comparison is complete
- Patch file application: same performance as comparison

#### NFR-2: Human-Readable Patch File
- Patch file must be readable and editable by a developer without special tools
- JSON format with descriptive field names and comments (via `_comment` fields)

#### NFR-3: Extensibility
- Iteration 1: structural comparison only (modules + links)
- Iteration 2: add property/calibration comparison after structural mapping is frozen
- Algorithm and data model must support this incremental expansion without redesign

#### NFR-4: Correctness
- Subgraph matching must be deterministic given the same inputs
- Voting aggregation must produce a stable, reproducible mapping
- No false positives (actions that would corrupt a valid target file)

#### NFR-5: Integration Compatibility
- No breaking changes to existing APIs or DB schema (only additive changes)
- `isReadonly` columns are nullable with default `false` — backward compatible

---

## 3. Architecture Decision Records

### ADR-001: Usecase GKV as Primary Matching Key

**Decision:** Usecases are matched across files using their GKV (Global Key-Value vector — the `keyVector.valueSystemIds` array). ValueSystemIds are stable across files.

**Rationale:** Usecase `systemId` is file-local and cannot be used for cross-file comparison. The GKV uniquely identifies a usecase's audio processing context (device, sample rate, stream type, etc.) and is stable across file versions. GKV is guaranteed unique within a file.

**Consequences:** Usecases with no GKV match in the other file are treated as entirely Added or Removed.

**Status:** Accepted

---

### ADR-002: Two-Level Graph Matching (Usecase Graph → Subgraph Graph)

**Decision:** Comparison proceeds in two levels:
1. **Level 1**: Match subgraphs within a usecase by treating the usecase as a directed graph (nodes = subgraphs, edges = subgraph pairs)
2. **Level 2**: Score subgraph similarity by treating each subgraph as a directed graph (nodes = modules, edges = data-links + control-links)

**Rationale:** Both usecases and subgraphs are DAGs, not linear sequences. Sequence-alignment algorithms (LCS, Needleman-Wunsch, DTW) are invalid because:
- Subgraph pairs can form fan-out/fan-in topologies (e.g., SG1→SG2, SG1→SG3, SG2→SG4)
- Module connections can form fan-out/fan-in topologies (e.g., M1→M2, M2→M3, M2→M4)
- Some modules may be isolated (not connected to any other module)

**Consequences:** Graph matching algorithms (Hungarian + edge matching) are used at both levels.

**Status:** Accepted

---

### ADR-003: Hungarian Algorithm + Edge Matching for Graph Similarity

**Decision:** Graph similarity between two subgraphs (or two usecase subgraph-graphs) is computed using:
1. **Node matching**: Hungarian algorithm on a node similarity matrix
2. **Edge matching**: After node matching, count matched directed edges
3. **Score**: weighted combination of node match ratio and edge match ratio

**Rationale:** See Section 5.7 (Algorithm Comparison Tables) for full analysis. Hungarian + Edge Matching is chosen because:
- Nodes have clear labels (`definitionSystemId` for modules; subgraph fingerprint for subgraphs)
- O(n³) is trivial for n ≤ 10 nodes
- Handles isolated nodes naturally
- Simple to implement, test, and reason about
- Exact GED is also feasible at this scale but significantly more complex with no practical benefit

**Status:** Accepted

---

### ADR-004: Voting Aggregation Across Usecases for Final Subgraph Mapping

**Decision:** The final subgraph mapping (ref_SG → tar_SG) is determined by aggregating similarity scores across all usecases that contain both subgraphs.

**Algorithm:**
```
For each usecase pair (ref_UC, tar_UC) with same GKV:
  Run graph matching → get assignment {ref_SG_i → tar_SG_j, score_ij}
  votes[ref_SG_fingerprint][tar_SG_fingerprint] += score_ij

Final mapping: for each ref_SG, pick tar_SG with highest accumulated votes
```

**Rationale:** A subgraph may appear in multiple usecases. Aggregating votes across all usecases gives a more robust mapping than any single usecase comparison. If SG1 maps to SG3 in 10 usecases with high scores and to SG5 in 3 usecases with low scores, SG1→SG3 is the correct mapping.

**Status:** Accepted

---

### ADR-005: Subgraph Fingerprint as Stable Identity

**Decision:** A subgraph is identified in the patch file by a **fingerprint** computed as:
```
fingerprint = hash(
  sorted(module.definitionSystemId for module in subgraph.modules)
  + sorted((src.definitionSystemId, dst.definitionSystemId) for link in subgraph.dataLinks)
  + sorted((src.definitionSystemId, dst.definitionSystemId) for link in subgraph.controlLinks)
)
```

**Rationale:** Subgraph names and system IDs are not stable across files. The fingerprint captures both the node set (module types) and the edge structure (connections), making it stable for the same logical subgraph across file versions.

**Disambiguation:** When two subgraphs in the same usecase have identical fingerprints (e.g., two stereo channels with the same module topology), they are disambiguated using their **graph neighborhood** within the usecase:
```
SubgraphRef = {
  gkv: [...],
  fingerprint: "...",
  predecessors: [fingerprint_of_incoming_SGs],  // from subgraph pairs
  successors: [fingerprint_of_outgoing_SGs]     // from subgraph pairs
}
```

**Status:** Accepted

---

### ADR-006: isReadonly Flag at Module, Subgraph, and Usecase Level

**Decision:** A boolean `isReadonly` column is added to the `spf_modules`, `subgraphs`, and `use_cases` DB tables. Default value is `false`.

**Behavior:**
- `isReadonly = true` on a module: no DELETE or MODIFY actions generated for that module
- `isReadonly = true` on a subgraph: no DELETE or MODIFY actions for the subgraph or any of its modules
- `isReadonly = true` on a usecase: no DELETE or MODIFY actions for the usecase, its subgraphs, or their modules
- ADD actions from the reference file are still generated even for readonly entities (shown to user as new additions)

**Rationale:** Customers customize their ACDB files (e.g., replacing a vendor module with a proprietary one, adding a new subgraph). These customizations must survive diff-merge operations. The `isReadonly` flag is a one-time annotation that protects customizations permanently.

**Scope:** `isReadonly` is only considered on the **Target** file. Base and Ref files are treated as clean vendor files.

**Status:** Accepted

---

### ADR-007: Conflicts as Validation Errors

**Decision:** Conflicts (cases where a delta action cannot be applied to the target) are reported as validation errors in the API response. They are not stored as a separate DB table.

**Rationale:** Conflicts require user action before they can be resolved. Storing them in the DB adds complexity. The API response provides all conflict information needed for the user to take action. After the user resolves a conflict (e.g., removes the `isReadonly` flag, or manually adds a missing entity), the comparison can be re-run or the specific action can be manually added.

**Status:** Accepted

---

### ADR-008: edit_actions Ordering — DELETE → UPDATE → ADD

**Decision:** Generated `edit_actions` are ordered: DELETE operations first, then UPDATE, then ADD (CREATE).

**Rationale:** This ordering is dependency-safe:
- DELETEs remove entities that may conflict with new additions
- UPDATEs modify existing entities
- ADDs create new entities that may depend on updated entities

**Status:** Accepted

---

### ADR-009: Two-Way Comparison as Degenerate Three-Way Merge

**Decision:** Two-way comparison (Ref vs Target) is implemented as a degenerate case of three-way merge where Base = Target.

**Rationale:** This avoids code duplication. The three-way merge algorithm computes delta = Ref − Base and applies it to Target. When Base = Target, delta = Ref − Target, and applying it to Target produces actions to make Target look like Ref. The user still chooses which actions to apply.

**Implementation note:** The Base file does not need to be physically uploaded twice. The system uses the Target file's data as the Base when in two-way mode.

**Status:** Accepted

---

### ADR-010: Worker Pool Parallelism at Usecase-Batch Level

**Decision:** Comparison is parallelized at the usecase level using the existing `IWorkerPool` infrastructure. Usecases are batched and distributed across worker threads.

**Rationale:** Usecase-level comparison is embarrassingly parallel — each usecase pair (same GKV) is independent. The existing worker pool (used in the upload-file workflow) provides the infrastructure. Voting aggregation is performed in the main thread after all workers complete.

**Batch size:** Determined at runtime based on worker count and total usecase count. Typical: `ceil(total_usecases / worker_count)` usecases per worker.

**Status:** Accepted

---

### ADR-011: Patch File Uses Stable Domain Identifiers Only

**Decision:** The patch file never contains file-local system IDs (`systemId`, `subgraphId`, `instanceId`). All entity references use stable identifiers:
- Usecase: GKV (`valueSystemIds` array)
- Subgraph: fingerprint + GKV context + graph neighborhood
- Module: `definitionSystemId` + subgraph fingerprint context + graph neighborhood (predecessor/successor `definitionSystemId`s)
- Definition: `definitionSystemId`

**Rationale:** Patch files must be applicable to any target file, not just the specific file they were created from. File-local IDs are meaningless in a different file.

**Status:** Accepted

---

### ADR-012: Definitions Comparison by definitionSystemId

**Decision:** `SpfModuleDefinition` entities are compared by `definitionSystemId`, which is stable across files.

**Actions generated:**
- Definition in Ref but not in Target → ADD action for the definition
- Definition in Target but not in Ref → no action (Target may have extra definitions)
- Definition in both but with changed properties → UPDATE action

**Conflict:** If a delta action adds a module of type X but definition X is not in Target and no ADD action for definition X was generated (e.g., definition X is readonly in Target), this is a **Definition Missing Conflict**.

**Status:** Accepted

---

## 4. Data Model Changes

### 4.1 isReadonly Column Additions

Three new columns are added to existing tables. All are nullable with default `false` for backward compatibility.

```sql
-- Add to spf_modules table
ALTER TABLE spf_modules ADD COLUMN is_readonly INTEGER NOT NULL DEFAULT 0;

-- Add to subgraphs table
ALTER TABLE subgraphs ADD COLUMN is_readonly INTEGER NOT NULL DEFAULT 0;

-- Add to use_cases table
ALTER TABLE use_cases ADD COLUMN is_readonly INTEGER NOT NULL DEFAULT 0;
```

**Domain entity changes:**

```typescript
// SpfModule entity — add field
readonly isReadonly: boolean = false;

// Subgraph entity — add field
readonly isReadonly: boolean = false;

// UseCase entity — add field
readonly isReadonly: boolean = false;
```

**Inheritance of readonly:**
- If a subgraph has `isReadonly = true`, all its modules are treated as readonly (even if their individual flag is `false`)
- If a usecase has `isReadonly = true`, all its subgraphs and their modules are treated as readonly
- This inheritance is evaluated at comparison time, not stored redundantly

### 4.2 Comparison Session Context

The diff-merge comparison requires an active `DIFF_MERGE` session on the target file. The existing `project_sessions` table with `session_mode = 'DIFF_MERGE'` is used. No new tables are needed.

### 4.3 Patch File JSON Schema

See Section 9 for the full patch file format specification.

---

## 5. Algorithm Design

### 5.1 Overview

The comparison algorithm proceeds in five phases:

```
Phase 1: Usecase Matching
  → Match usecases by GKV (exact match)
  → Identify added/removed usecases

Phase 2: Subgraph Graph Matching (per usecase pair)
  → For each matched usecase pair, match subgraphs using graph matching
  → Accumulate votes across all usecase pairs
  → Resolve final subgraph mapping by highest vote

Phase 3: Module Graph Matching (per matched subgraph pair)
  → For each matched subgraph pair, match modules using graph matching
  → Identify added/removed/matched modules

Phase 4: Link Matching (per matched subgraph pair)
  → After module matching, match data-links and control-links
  → Identify added/removed links

Phase 5: Property & Calibration Comparison (Iteration 2)
  → For each matched module pair, compare CKV data, tag data, port configs
  → Generate UPDATE actions for changed properties
```

Phases 1–4 are implemented in Iteration 1. Phase 5 is deferred to Iteration 2.

---

### 5.2 Phase 1: Usecase Matching

**Input:** Two sets of usecases (ref usecases, target usecases), each identified by GKV.

**Algorithm:**
```
refUsecaseMap = Map<GKV_key, UseCase>  // GKV_key = JSON.stringify(sorted valueSystemIds)
tarUsecaseMap = Map<GKV_key, UseCase>

matchedPairs = []
addedUsecases = []    // in ref, not in target
removedUsecases = []  // in target, not in ref

for each (gkvKey, refUC) in refUsecaseMap:
  if tarUsecaseMap.has(gkvKey):
    matchedPairs.push({ ref: refUC, tar: tarUsecaseMap.get(gkvKey) })
  else:
    addedUsecases.push(refUC)

for each (gkvKey, tarUC) in tarUsecaseMap:
  if not refUsecaseMap.has(gkvKey):
    removedUsecases.push(tarUC)
```

**Output:** `matchedPairs`, `addedUsecases`, `removedUsecases`

**Complexity:** O(U) where U = number of usecases

---

### 5.3 Phase 2: Subgraph Graph Matching

#### 5.3.1 Per-Usecase Subgraph Matching

For each matched usecase pair `(ref_UC, tar_UC)`:

**Step 1: Build subgraph graphs**
```
ref_graph = {
  nodes: ref_UC.subgraphSystemIds → [Subgraph objects],
  edges: ref_UC.subgraphPairs → [(source_SG, dest_SG)]
}
tar_graph = {
  nodes: tar_UC.subgraphSystemIds → [Subgraph objects],
  edges: tar_UC.subgraphPairs → [(source_SG, dest_SG)]
}
```

**Step 2: Compute pairwise subgraph similarity matrix**
```
sim[i][j] = subgraphSimilarity(ref_graph.nodes[i], tar_graph.nodes[j])
```
Where `subgraphSimilarity` is computed in Phase 3 (module graph matching).

**Step 3: Hungarian algorithm for optimal node assignment**
```
assignment = hungarianAlgorithm(sim)
// assignment[i] = j means ref_SG[i] is matched to tar_SG[j]
// Unmatched ref nodes → added subgraphs
// Unmatched tar nodes → removed subgraphs (or customer-added if readonly)
```

**Step 4: Edge matching**
```
for each (ref_pair, tar_pair) in subgraphPairs:
  if ref_pair.source maps to tar_pair.source AND ref_pair.dest maps to tar_pair.dest:
    matched_pairs++
```

**Step 5: Accumulate votes**
```
for each matched (ref_SG[i], tar_SG[j]) with score s:
  votes[fingerprint(ref_SG[i])][fingerprint(tar_SG[j])] += s
```

#### 5.3.2 Voting Aggregation

After processing all usecase pairs:
```
finalMapping = Map<ref_SG_fingerprint, tar_SG_fingerprint>

for each ref_SG_fingerprint:
  best_tar = argmax_j votes[ref_SG_fingerprint][j]
  finalMapping[ref_SG_fingerprint] = best_tar
```

**Conflict resolution in voting:** If two ref subgraphs both vote for the same tar subgraph, the one with the higher total vote score wins. The other is treated as unmatched (added).

---

### 5.4 Phase 3: Module Graph Matching (Subgraph Similarity Scoring)

For each subgraph pair `(ref_SG, tar_SG)`:

**Step 1: Build module graphs**
```
ref_nodes = ref_SG.modules  // SpfModule[]
ref_edges = ref_SG.dataLinks ∪ ref_SG.controlLinks  // directed edges

tar_nodes = tar_SG.modules
tar_edges = tar_SG.dataLinks ∪ tar_SG.controlLinks
```

**Step 2: Node similarity matrix**
```
node_sim[i][j] = 1.0 if ref_nodes[i].definitionSystemId == tar_nodes[j].definitionSystemId
               = 0.0 otherwise
```

**Step 3: Hungarian algorithm for node assignment**
```
node_assignment = hungarianAlgorithm(node_sim)
matched_nodes = count of matched pairs with score > 0
```

**Step 4: Edge matching**
```
for each ref_edge (ref_src, ref_dst):
  tar_src = node_assignment[ref_src]
  tar_dst = node_assignment[ref_dst]
  if tar_src exists AND tar_dst exists AND (tar_src → tar_dst) in tar_edges:
    matched_edges++
```

**Step 5: Similarity score**
```
W_NODE = 0.7
W_EDGE = 0.3

node_score = matched_nodes / max(len(ref_nodes), len(tar_nodes))
edge_score = matched_edges / max(len(ref_edges), len(tar_edges))  // 0 if no edges

similarity = W_NODE * node_score + W_EDGE * edge_score
```

**Isolated nodes:** Modules not connected to any other module contribute to `node_score` but not `edge_score`. This is handled naturally by the formula above.

**Output:** `similarity` score (0.0–1.0), `node_assignment` map

---

### 5.5 Phase 4: Link Matching

After module matching, for each matched subgraph pair:

**Data-link matching:**
```
for each ref_data_link (ref_src_module, ref_dst_module):
  tar_src = moduleMapping[ref_src_module]
  tar_dst = moduleMapping[ref_dst_module]

  if tar_src is None or tar_dst is None:
    → ADD action for this link (source or dest module was added)
  elif (tar_src → tar_dst) exists in tar_SG.dataLinks:
    → UNCHANGED (link exists in both)
  else:
    → ADD action for this link (link missing in target)

for each tar_data_link not matched above:
  → REMOVE action for this link
```

**Control-link matching:** Same algorithm as data-link matching.

**Subgraph pair matching:**
```
for each ref_subgraph_pair (ref_src_SG, ref_dst_SG):
  tar_src_SG = subgraphMapping[ref_src_SG]
  tar_dst_SG = subgraphMapping[ref_dst_SG]

  if tar_src_SG and tar_dst_SG exist:
    if (tar_src_SG → tar_dst_SG) in tar_UC.subgraphPairs:
      → UNCHANGED
    else:
      → ADD action for this subgraph pair
  else:
    → ADD action (one or both subgraphs are new)
```

---

### 5.6 Phase 5: Property & Calibration Comparison (Iteration 2)

After structural mapping is frozen (Phases 1–4 complete), for each matched module pair `(ref_module, tar_module)`:

- Compare `alias` → UPDATE action if different
- Compare `ckvs` (calibration key-value data) → UPDATE action for each changed CKV
- Compare `tagDataList` → ADD/REMOVE actions for changed tags
- Compare port configurations → UPDATE action if different

For each matched subgraph pair:
- Compare `properties` (SubgraphPropertyData) → UPDATE action for each changed property
- Compare `vcpmDataInstance` → UPDATE action if different

---

### 5.7 Algorithm Comparison Tables

#### Table A: Algorithms for Graph Matching (Both Levels)

| Algorithm | Handles Node Labels | Handles DAG Edges | Handles Isolated Nodes | Time Complexity | Feasible (n≤10) | Selected |
|-----------|--------------------|--------------------|----------------------|-----------------|-----------------|----------|
| **Hungarian + Edge Matching** | ✅ | ✅ | ✅ | O(n³) | ✅ | ✅ **YES** |
| Exact Graph Edit Distance (GED) | ✅ | ✅ | ✅ | NP-hard (exact) | ✅ | ❌ |
| Approximate GED (beam search) | ✅ | ✅ | ✅ | O(n²) | ✅ | ❌ |
| VF2 (subgraph isomorphism) | ✅ | ✅ | ✅ | O(n!) worst | ✅ | ❌ |
| Weisfeiler-Lehman (WL) Kernel | ✅ | ✅ | ✅ | O(n×k) | ✅ | ❌ |
| Spectral Graph Matching | ❌ | ✅ | ✅ | O(n³) | ✅ | ❌ |
| Needleman-Wunsch | ✅ | ❌ (sequences only) | ❌ | O(n×m) | ✅ | ❌ |
| LCS | ✅ | ❌ (sequences only) | ❌ | O(n×m) | ✅ | ❌ |
| Dynamic Time Warping (DTW) | ✅ | ❌ (sequences only) | ❌ | O(n×m) | ✅ | ❌ |
| Hungarian (nodes only, no edges) | ✅ | ❌ | ✅ | O(n³) | ✅ | ❌ |

**Why Hungarian + Edge Matching was chosen:**
- Nodes have clear, stable labels (`definitionSystemId` for modules; fingerprint for subgraphs) → Hungarian algorithm on a binary similarity matrix is optimal and exact
- Edge matching after node matching is O(e) and captures graph structure
- Isolated nodes are handled naturally (they contribute to node score only)
- O(n³) is trivial for n ≤ 10; no approximation needed
- Simple to implement, test, and reason about
- Exact GED is also feasible at this scale but requires significantly more complex implementation (branch-and-bound or A* search) with no practical benefit given the small graph sizes
- WL Kernel is designed for ML pipelines and is unnecessarily complex for this use case
- Sequence-alignment algorithms (NW, LCS, DTW) are invalid because both usecases and subgraphs are DAGs, not linear sequences

#### Table B: Algorithms for Sequence Alignment (Rejected — Not Applicable)

These algorithms were considered but rejected because the structures being compared are DAGs, not linear sequences:

| Algorithm | Reason for Rejection |
|-----------|---------------------|
| Needleman-Wunsch | Assumes linear sequences; cannot handle fan-out/fan-in topologies |
| LCS | Assumes linear sequences; no substitution handling |
| Dynamic Time Warping | Designed for continuous time-series signals; warps rather than gaps; not appropriate for discrete graph nodes |
| Smith-Waterman | Local sequence alignment; less relevant for full-graph comparison |

---

## 6. System Architecture

### 6.1 Component Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    packages/api (NestJS)                         │
│                                                                  │
│   REST Controllers (DiffMergeController)                         │
│   → StartDiffMergeSessionCommand                                 │
│   → ExecuteComparisonCommand                                     │
│   → CreatePatchFileCommand                                       │
│   → ApplyPatchFileCommand                                        │
│   → SetReadonlyCommand                                           │
└──────────────────────────────┬──────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────┐
│                    packages/core (Application)                   │
│                                                                  │
│   DiffMergeOrchestrator                                          │
│   ├── UsecaseMatchingService      (Phase 1)                      │
│   ├── SubgraphMatchingService     (Phase 2 — uses worker pool)   │
│   ├── ModuleMatchingService       (Phase 3)                      │
│   ├── LinkMatchingService         (Phase 4)                      │
│   ├── VotingAggregationService    (post-parallel aggregation)    │
│   ├── DeltaComputationService     (3-way: Ref−Base)              │
│   ├── DeltaApplicationService     (apply delta to Target)        │
│   ├── ConflictDetectionService    (readonly + missing entity)    │
│   ├── PatchFileSerializer         (edit_actions → patch JSON)    │
│   └── PatchFileDeserializer       (patch JSON → edit_actions)    │
│                                                                  │
│   Ports:                                                         │
│   ├── IDiffMergeRepository        (read usecases/SGs/modules)    │
│   └── IWorkerPool                 (existing)                     │
└──────────────────────────────┬──────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────┐
│                    packages/infrastructure/persistence            │
│                                                                  │
│   DiffMergeRepository (implements IDiffMergeRepository)          │
│   ├── Reads from: use_cases, subgraphs, spf_modules,             │
│   │               data_links, control_links, subgraph_pairs,     │
│   │               spf_module_definitions                         │
│   └── Writes to: edit_actions (unstaged, DIFF_MERGE session)     │
│                                                                  │
│   Worker: SubgraphMatchingWorker                                 │
│   └── Runs Phase 2+3 for a batch of usecase pairs               │
└─────────────────────────────────────────────────────────────────┘
```

### 6.2 CQRS Commands and Queries

**Commands (write operations):**

| Command | Description |
|---------|-------------|
| `ExecuteComparisonCommand` | Run comparison between ref and target (2-way or 3-way), produce unstaged edit_actions |
| `CreatePatchFileCommand` | Serialize comparison result to patch file JSON |
| `ApplyPatchFileCommand` | Deserialize patch file and produce unstaged edit_actions |
| `SetEntityReadonlyCommand` | Set `isReadonly` flag on a module, subgraph, or usecase |

**Queries (read operations):**

| Query | Description |
|-------|-------------|
| `GetComparisonSummaryQuery` | Get summary of last comparison (counts of added/removed/modified/conflicts) |
| `GetConflictsQuery` | Get list of conflicts from last comparison |

### 6.3 Worker Pool Integration

The existing `IWorkerPool` infrastructure is reused. A new worker type `subgraph-matching` is added:

```typescript
// Worker input (per batch)
interface SubgraphMatchingWorkerInput {
  type: 'subgraph-matching';
  usecasePairs: Array<{
    refUC: SerializedUsecase;
    tarUC: SerializedUsecase;
  }>;
}

// Worker output (per batch)
interface SubgraphMatchingWorkerOutput {
  votes: Array<{
    refFingerprint: string;
    tarFingerprint: string;
    score: number;
  }>;
}
```

**Parallelization strategy:**
```
total_usecases = matchedPairs.length
worker_count = workerPool.size  // e.g., 4 workers
batch_size = ceil(total_usecases / worker_count)

batches = chunk(matchedPairs, batch_size)
results = await Promise.all(batches.map(batch => workerPool.execute({
  type: 'subgraph-matching',
  usecasePairs: batch
})))

// Aggregate votes from all workers
allVotes = results.flatMap(r => r.votes)
finalMapping = aggregateVotes(allVotes)
```

---

## 7. Workflows

### 7.1 Two-Way Comparison Workflow

```
1. User uploads Target file (existing upload-file API)
2. User uploads Reference file (existing upload-file API)
3. User starts DIFF_MERGE session on Target file
   POST /projects/:targetProjectId/start-session { mode: "DIFF_MERGE" }

4. User executes comparison
   POST /projects/:targetProjectId/diff-merge/compare
   Body: { refProjectId: "...", sessionId: "..." }

5. System runs comparison (Base = Target, Ref = Reference):
   a. Phase 1: Match usecases by GKV
   b. Phase 2+3: Parallel subgraph + module matching (worker pool)
   c. Phase 4: Link matching
   d. Voting aggregation → final mapping
   e. Generate edit_actions (DELETE → UPDATE → ADD)
   f. Detect conflicts (readonly violations, missing entities)
   g. Write non-conflicting actions as UNSTAGED edit_actions
   h. Return comparison summary + conflict list

6. User reviews comparison result (UI/CLI)
   - Sees added/removed/modified usecases, subgraphs, modules, links
   - Sees conflict list with descriptions and suggested resolutions

7. User resolves conflicts (if any)
   - May set isReadonly = false on a module to allow modification
   - May manually add a missing entity
   - Re-runs comparison or manually adds specific actions

8. User stages desired actions
   POST /projects/:targetProjectId/stage-changes { changeIds: [...] }

9. User commits
   POST /projects/:targetProjectId/commit-changes { commitMessage: "..." }
```

### 7.2 Three-Way Merge Workflow

```
1. User uploads Base file (common ancestor)
2. User uploads Reference file (updated vendor version)
3. User uploads Target file (customer-customized version)
   (or Target is already in the system)

4. User marks customizations as readonly in Target (one-time setup)
   PATCH /projects/:targetProjectId/entities/:entityId/readonly { isReadonly: true }

5. User starts DIFF_MERGE session on Target file
   POST /projects/:targetProjectId/start-session { mode: "DIFF_MERGE" }

6. User executes three-way merge
   POST /projects/:targetProjectId/diff-merge/merge
   Body: { baseProjectId: "...", refProjectId: "...", sessionId: "..." }

7. System computes delta = Ref − Base:
   a. Match usecases between Base and Ref (by GKV)
   b. Match subgraphs between Base and Ref (graph matching)
   c. Match modules between Base and Ref
   d. Identify: added/removed/modified usecases, subgraphs, modules, links

8. System applies delta to Target:
   a. For each delta action, locate the corresponding entity in Target
      (using same graph matching: GKV → subgraph fingerprint → module definitionSystemId)
   b. Check isReadonly on located entity
   c. If readonly → conflict; if not found → conflict; otherwise → generate edit_action
   d. Write non-conflicting actions as UNSTAGED edit_actions

9. User reviews, resolves conflicts, stages, commits (same as steps 6–9 above)
```

### 7.3 Create Patch File Workflow

```
1. User runs comparison (2-way or 3-way) as above
2. User reviews and selects which actions to include in patch
3. User creates patch file
   POST /projects/:targetProjectId/diff-merge/create-patch
   Body: { sessionId: "...", changeIds: [...], description: "..." }

4. System serializes selected edit_actions to patch file JSON:
   - Translates file-local systemIds to stable identifiers
     (GKV, subgraph fingerprint + neighborhood, module definitionSystemId + neighborhood)
   - Writes patch file JSON

5. System returns patch file as download
   (or saves to file system)
```

### 7.4 Apply Patch File Workflow

```
1. User uploads Target file (if not already in system)
2. User starts DIFF_MERGE session on Target file
3. User uploads patch file
   POST /projects/:targetProjectId/diff-merge/apply-patch
   Body: { sessionId: "...", patchFile: <multipart> }

4. System deserializes patch file:
   a. For each operation in patch file:
      - Locate target entity using stable identifiers + graph matching
      - Check isReadonly
      - If located and not readonly → generate edit_action
      - If not located → conflict (entity not found in target)
      - If readonly → conflict (readonly violation)

5. System writes non-conflicting actions as UNSTAGED edit_actions
6. Returns summary + conflict list

7. User reviews, resolves conflicts, stages, commits
```

### 7.5 Readonly Annotation Workflow

```
1. User uploads their customized Target file
2. User identifies their customizations (modules, subgraphs, usecases they added/modified)
3. User marks them as readonly via API:
   PATCH /projects/:projectId/modules/:moduleId/readonly { isReadonly: true }
   PATCH /projects/:projectId/subgraphs/:subgraphId/readonly { isReadonly: true }
   PATCH /projects/:projectId/usecases/:usecaseId/readonly { isReadonly: true }

4. This is a one-time setup. The readonly flags persist in the DB.
5. All future diff-merge operations on this file will respect these flags.
```

---

## 8. Conflict Handling

### 8.1 Conflict Types

| Conflict Type | Description | Auto-Resolvable | Resolution |
|---------------|-------------|-----------------|------------|
| **READONLY_DELETE** | Delta says DELETE entity X, but X is `isReadonly` in Target | ❌ | User removes readonly flag, or skips the action |
| **READONLY_UPDATE** | Delta says UPDATE entity X, but X is `isReadonly` in Target | ❌ | User removes readonly flag, or skips the action |
| **ENTITY_NOT_FOUND** | Delta says DELETE/UPDATE entity X, but X cannot be found in Target | ✅ (skip) | Auto-skip: entity already absent; log as warning |
| **DEFINITION_MISSING** | Delta says ADD module of type X, but definition X not in Target | ❌ | User adds definition X first, or skips the action |
| **STRUCTURAL_CONFLICT** | Delta says ADD link A→B, but module A or B not found in Target | ❌ | User adds missing module first, or skips the link |
| **AMBIGUOUS_MATCH** | Multiple target entities match the patch file reference equally well | ❌ | User selects which entity to apply the action to |

### 8.2 Conflict Report Structure

```typescript
interface ConflictReport {
  conflictId: string;
  type: 'READONLY_DELETE' | 'READONLY_UPDATE' | 'ENTITY_NOT_FOUND'
      | 'DEFINITION_MISSING' | 'STRUCTURAL_CONFLICT' | 'AMBIGUOUS_MATCH';
  severity: 'ERROR' | 'WARNING';
  autoResolvable: boolean;
  description: string;
  affectedEntity: {
    level: 'usecase' | 'subgraph' | 'module' | 'link' | 'definition';
    identity: string;  // human-readable: "Module 'Decoder' (defId: 1001) in SG 'SG_Playback' of UC {Device:Headphone}"
  };
  suggestedResolution: string;
  deltaOperation: DeltaOperation;  // the operation that caused the conflict
}
```

### 8.3 Auto-Resolution

**ENTITY_NOT_FOUND** conflicts are auto-resolved by skipping the action:
- If delta says DELETE module M but M is not in Target → skip (M is already absent; no action needed)
- This is logged as a WARNING, not an ERROR

All other conflict types require manual user action.

### 8.4 User Resolution Flow

```
1. User receives conflict report in API response
2. For each conflict:
   a. READONLY_DELETE/UPDATE:
      - Option A: PATCH /entities/:id/readonly { isReadonly: false } → re-run comparison
      - Option B: Skip this action (don't stage it)
   b. DEFINITION_MISSING:
      - Option A: Manually add the definition → re-run comparison
      - Option B: Skip all actions that depend on this definition
   c. STRUCTURAL_CONFLICT:
      - Option A: Manually add the missing module → re-run comparison
      - Option B: Skip the link action
   d. AMBIGUOUS_MATCH:
      - User selects which entity to apply the action to via API
3. After resolving all conflicts, user stages desired actions and commits
```

---

## 9. Patch File Format

### 9.1 Schema Overview

```json
{
  "version": "1.0",
  "format": "arc-patch",
  "metadata": {
    "created": "2026-05-30T10:00:00Z",
    "description": "Delta from vendor v2.0 to v2.1",
    "sourceGitHash": "abc123",
    "targetGitHash": "def456"
  },
  "operations": [
    { ... }
  ]
}
```

### 9.2 Entity Reference Types

**Usecase reference** (by GKV):
```json
{
  "type": "usecase",
  "gkv": [101, 202, 303]
}
```

**Subgraph reference** (by fingerprint + GKV context + neighborhood):
```json
{
  "type": "subgraph",
  "usecaseGkv": [101, 202, 303],
  "fingerprint": "a3f8c2d1",
  "predecessors": [],
  "successors": ["b4e9d3f2"]
}
```

**Module reference** (by definitionSystemId + subgraph context + neighborhood):
```json
{
  "type": "module",
  "subgraph": { "usecaseGkv": [101, 202, 303], "fingerprint": "a3f8c2d1", ... },
  "definitionSystemId": 1001,
  "predecessors": [],
  "successors": [1002, 1003]
}
```

**Definition reference** (by definitionSystemId):
```json
{
  "type": "definition",
  "definitionSystemId": 1001
}
```

### 9.3 Operation Types

#### ADD_USECASE
```json
{
  "op": "add_usecase",
  "usecase": {
    "gkv": [101, 202, 303],
    "alias": "Headphone Playback",
    "subgraphs": ["a3f8c2d1", "b4e9d3f2"],
    "subgraphPairs": [
      { "source": "a3f8c2d1", "dest": "b4e9d3f2" }
    ]
  }
}
```

#### REMOVE_USECASE
```json
{
  "op": "remove_usecase",
  "target": { "type": "usecase", "gkv": [101, 202, 303] }
}
```

#### ADD_SUBGRAPH
```json
{
  "op": "add_subgraph",
  "usecaseGkv": [101, 202, 303],
  "subgraph": {
    "fingerprint": "a3f8c2d1",
    "name": "SG_Decoder",
    "isExported": false,
    "modules": [
      { "definitionSystemId": 1001, "alias": "Decoder", "predecessors": [], "successors": [1002] },
      { "definitionSystemId": 1002, "alias": "Mixer", "predecessors": [1001], "successors": [] }
    ],
    "dataLinks": [
      { "sourceDefId": 1001, "destDefId": 1002 }
    ],
    "controlLinks": []
  }
}
```

#### REMOVE_SUBGRAPH
```json
{
  "op": "remove_subgraph",
  "target": {
    "type": "subgraph",
    "usecaseGkv": [101, 202, 303],
    "fingerprint": "a3f8c2d1",
    "predecessors": [],
    "successors": ["b4e9d3f2"]
  }
}
```

#### ADD_MODULE
```json
{
  "op": "add_module",
  "target": {
    "type": "subgraph",
    "usecaseGkv": [101, 202, 303],
    "fingerprint": "a3f8c2d1",
    "predecessors": [],
    "successors": ["b4e9d3f2"]
  },
  "module": {
    "definitionSystemId": 2001,
    "alias": "NewEqualizer",
    "predecessors": [1001],
    "successors": [1002]
  }
}
```

#### REMOVE_MODULE
```json
{
  "op": "remove_module",
  "target": {
    "type": "module",
    "subgraph": { "usecaseGkv": [101, 202, 303], "fingerprint": "a3f8c2d1", ... },
    "definitionSystemId": 2001,
    "predecessors": [1001],
    "successors": [1002]
  }
}
```

#### UPDATE_MODULE (Iteration 2)
```json
{
  "op": "update_module",
  "target": {
    "type": "module",
    "subgraph": { ... },
    "definitionSystemId": 2001,
    "predecessors": [1001],
    "successors": [1002]
  },
  "changes": {
    "alias": "RenamedEqualizer",
    "ckv": [
      { "key": 5001, "value": 6001, "op": "update" }
    ]
  }
}
```

#### ADD_LINK
```json
{
  "op": "add_link",
  "linkType": "data",
  "subgraph": { "usecaseGkv": [101, 202, 303], "fingerprint": "a3f8c2d1", ... },
  "link": {
    "sourceModule": { "definitionSystemId": 1001, "predecessors": [], "successors": [1002] },
    "destModule": { "definitionSystemId": 1002, "predecessors": [1001], "successors": [] }
  }
}
```

#### REMOVE_LINK
```json
{
  "op": "remove_link",
  "linkType": "data",
  "subgraph": { ... },
  "link": {
    "sourceModule": { "definitionSystemId": 1001, ... },
    "destModule": { "definitionSystemId": 1002, ... }
  }
}
```

#### ADD_SUBGRAPH_PAIR
```json
{
  "op": "add_subgraph_pair",
  "usecaseGkv": [101, 202, 303],
  "pair": {
    "sourceSubgraph": { "fingerprint": "a3f8c2d1", "predecessors": [], "successors": ["b4e9d3f2"] },
    "destSubgraph": { "fingerprint": "b4e9d3f2", "predecessors": ["a3f8c2d1"], "successors": [] }
  }
}
```

#### ADD_DEFINITION / REMOVE_DEFINITION / UPDATE_DEFINITION
```json
{
  "op": "add_definition",
  "definition": {
    "definitionSystemId": 3001,
    "name": "NewModuleType",
    "properties": { ... }
  }
}
```

### 9.4 Complete Patch File Example

```json
{
  "version": "1.0",
  "format": "arc-patch",
  "metadata": {
    "created": "2026-05-30T10:00:00Z",
    "description": "Add equalizer module to headphone playback path"
  },
  "operations": [
    {
      "_comment": "Step 1: Add the new module definition",
      "op": "add_definition",
      "definition": {
        "definitionSystemId": 3001,
        "name": "ParametricEqualizer"
      }
    },
    {
      "_comment": "Step 2: Remove old link between Decoder and Mixer",
      "op": "remove_link",
      "linkType": "data",
      "subgraph": {
        "usecaseGkv": [101, 202, 303],
        "fingerprint": "a3f8c2d1",
        "predecessors": [],
        "successors": ["b4e9d3f2"]
      },
      "link": {
        "sourceModule": { "definitionSystemId": 1001, "predecessors": [], "successors": [1002] },
        "destModule": { "definitionSystemId": 1002, "predecessors": [1001], "successors": [] }
      }
    },
    {
      "_comment": "Step 3: Add new Equalizer module",
      "op": "add_module",
      "target": {
        "type": "subgraph",
        "usecaseGkv": [101, 202, 303],
        "fingerprint": "a3f8c2d1",
        "predecessors": [],
        "successors": ["b4e9d3f2"]
      },
      "module": {
        "definitionSystemId": 3001,
        "alias": "ParametricEQ",
        "predecessors": [1001],
        "successors": [1002]
      }
    },
    {
      "_comment": "Step 4: Add link Decoder → Equalizer",
      "op": "add_link",
      "linkType": "data",
      "subgraph": {
        "usecaseGkv": [101, 202, 303],
        "fingerprint": "a3f8c2d1",
        "predecessors": [],
        "successors": ["b4e9d3f2"]
      },
      "link": {
        "sourceModule": { "definitionSystemId": 1001, "predecessors": [], "successors": [3001] },
        "destModule": { "definitionSystemId": 3001, "predecessors": [1001], "successors": [1002] }
      }
    },
    {
      "_comment": "Step 5: Add link Equalizer → Mixer",
      "op": "add_link",
      "linkType": "data",
      "subgraph": {
        "usecaseGkv": [101, 202, 303],
        "fingerprint": "a3f8c2d1",
        "predecessors": [],
        "successors": ["b4e9d3f2"]
      },
      "link": {
        "sourceModule": { "definitionSystemId": 3001, "predecessors": [1001], "successors": [1002] },
        "destModule": { "definitionSystemId": 1002, "predecessors": [3001], "successors": [] }
      }
    }
  ]
}
```

---

## 10. Performance Analysis

### 10.1 Complexity Analysis

| Phase | Algorithm | Complexity | Input Size | Estimated Time |
|-------|-----------|------------|------------|----------------|
| Phase 1: Usecase Matching | Hash map lookup | O(U) | U = 1500 usecases | < 1ms |
| Phase 2: Subgraph Graph Matching (per UC pair) | Hungarian O(n³) + edge matching O(e²) | O(S³ + E²) | S = 5 SGs, E = 5 pairs | < 0.1ms per UC |
| Phase 3: Module Graph Matching (per SG pair) | Hungarian O(m³) + edge matching O(l²) | O(M³ + L²) | M = 10 modules, L = 5 links | < 0.1ms per SG |
| Phase 4: Link Matching (per SG pair) | Linear scan | O(L) | L = 5 links | < 0.01ms per SG |
| Voting Aggregation | Hash map aggregation | O(U × S) | 1500 × 5 = 7500 | < 1ms |
| edit_actions generation | Linear | O(actions) | ~10,000 actions | < 10ms |

**Total sequential estimate:**
- Per usecase pair: ~0.5ms (Phase 2 + Phase 3 + Phase 4)
- Total for 1500 usecases: ~750ms sequential

**With parallelization (4 workers):**
- ~750ms / 4 = ~190ms for parallel phases
- Plus overhead (serialization, aggregation): ~50ms
- **Total estimated: ~250ms** — well within the 10-second target

### 10.2 Parallelization Strategy

```
Main Thread:
  1. Phase 1: Usecase matching (O(U), fast, not parallelized)
  2. Distribute matchedPairs across workers
  3. Wait for all workers
  4. Voting aggregation (O(U×S), fast, not parallelized)
  5. Phase 4: Link matching (after mapping is known)
  6. Generate edit_actions

Worker Threads (each handles a batch of usecase pairs):
  - Phase 2: Subgraph graph matching
  - Phase 3: Module graph matching (called from Phase 2 for similarity scoring)
  - Return: votes array
```

### 10.3 Memory Estimate

- Per usecase: ~5 subgraphs × 10 modules × 100 bytes = ~5KB
- Total for 1500 usecases: ~7.5MB per file
- Three files (Base, Ref, Target): ~22.5MB
- Similarity matrices: 5×5 per usecase × 1500 = 37,500 floats = ~300KB
- Votes map: ~7,500 entries = ~60KB
- **Total: ~25MB** — well within Node.js heap limits

### 10.4 Scalability

For larger files (up to 5000 usecases):
- Sequential time: ~2.5 seconds
- With 8 workers: ~350ms
- Still within the 10-second target

For very large files (>10,000 usecases), consider:
- Streaming comparison (process usecases in chunks)
- Database-level filtering (only load usecases with matching GKVs)

---

## 11. Testing Strategy

### 11.1 Unit Tests

**Location:** `packages/core/tests/unit/application/diff-merge/`

| Test Suite | Coverage |
|------------|----------|
| `usecase-matching.spec.ts` | GKV matching, added/removed usecases |
| `subgraph-graph-matching.spec.ts` | Hungarian algorithm, edge matching, similarity scoring |
| `module-graph-matching.spec.ts` | Module matching, isolated nodes, fan-out/fan-in |
| `link-matching.spec.ts` | Data-link and control-link matching |
| `voting-aggregation.spec.ts` | Vote accumulation, tie-breaking, one-to-many/many-to-many |
| `conflict-detection.spec.ts` | All conflict types, auto-resolution |
| `patch-file-serializer.spec.ts` | Serialization of edit_actions to patch JSON |
| `patch-file-deserializer.spec.ts` | Deserialization of patch JSON to edit_actions |
| `fingerprint.spec.ts` | Subgraph fingerprint computation, disambiguation |

**Key test scenarios:**

```typescript
// One-to-one subgraph mapping
describe('one-to-one subgraph mapping', () => {
  it('should map SG1 to SG3 when module sequences match', () => { ... })
})

// One-to-many: SG1 appears in UC1 and UC2 in ref; maps to different SGs in target
describe('one-to-many subgraph mapping', () => {
  it('should use voting to pick the best match across usecases', () => { ... })
})

// Fan-out topology: M1→M2, M2→M3, M2→M4
describe('fan-out module topology', () => {
  it('should correctly match modules in a fan-out DAG', () => { ... })
})

// Isolated module (not connected to any other module)
describe('isolated module handling', () => {
  it('should match isolated modules by definitionSystemId only', () => { ... })
})

// Readonly conflict
describe('readonly conflict detection', () => {
  it('should report READONLY_DELETE when delta deletes a readonly module', () => { ... })
  it('should still generate ADD actions adjacent to readonly modules', () => { ... })
})

// Identical subgraph fingerprints disambiguated by neighborhood
describe('subgraph fingerprint disambiguation', () => {
  it('should distinguish SG_Left and SG_Right using predecessor/successor context', () => { ... })
})
```

### 11.2 Integration Tests

**Location:** `packages/infrastructure/persistence/tests/integration/diff-merge/`

| Test Suite | Coverage |
|------------|----------|
| `diff-merge-repository.spec.ts` | Reading usecases/subgraphs/modules from DB for comparison |
| `edit-actions-writer.spec.ts` | Writing unstaged edit_actions from comparison result |
| `readonly-flag.spec.ts` | Setting/reading isReadonly flag on entities |

### 11.3 End-to-End Tests

**Location:** `packages/api/tests/e2e/diff-merge/`

| Test Suite | Coverage |
|------------|----------|
| `two-way-comparison.e2e-spec.ts` | Full two-way comparison workflow |
| `three-way-merge.e2e-spec.ts` | Full three-way merge workflow |
| `create-patch.e2e-spec.ts` | Create patch file from comparison |
| `apply-patch.e2e-spec.ts` | Apply patch file to target |
| `readonly-protection.e2e-spec.ts` | Readonly entities survive diff-merge |

### 11.4 Test Data Strategy

Test fixtures should cover:

| Scenario | Description |
|----------|-------------|
| **Identical files** | Ref = Target → zero edit_actions |
| **Added usecase** | Ref has UC not in Target → ADD_USECASE action |
| **Removed usecase** | Target has UC not in Ref → REMOVE_USECASE action |
| **Added module** | Ref SG has extra module → ADD_MODULE action |
| **Removed module** | Target SG has extra module → REMOVE_MODULE action |
| **Added link** | Ref SG has extra link → ADD_LINK action |
| **One-to-many SG** | SG1 shared across UC1 and UC2 → voting resolves correctly |
| **Fan-out topology** | M1→M2, M2→M3, M2→M4 → correct graph matching |
| **Isolated module** | Module with no links → matched by definitionSystemId |
| **Readonly module** | Delta deletes readonly module → READONLY_DELETE conflict |
| **Readonly subgraph** | Delta deletes readonly SG → conflict; ADD from ref still shown |
| **Missing entity** | Delta deletes module not in target → auto-skip (WARNING) |
| **Patch round-trip** | Create patch from comparison, apply to fresh target → same result |
| **Identical fingerprints** | Two SGs with same structure → disambiguated by neighborhood |

---

## 12. Document Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-05-30 | Architecture Team | Initial design document |

---

*End of Document*
