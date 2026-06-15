<!--
Copyright (c) Qualcomm Technologies, Inc. and/or its subsidiaries.
SPDX-License-Identifier: BSD-3-Clause
-->

# ACDB Human-Readable Format (HRF): Design Document

**Version:** 1.0
**Date:** June 2026
**Status:** Draft
**Audience:** Developers, Architects, Contributors

---

## Table of Contents

1. [Context & Goals](#1-context--goals)
2. [Requirements](#2-requirements)
3. [Architecture Decision Records](#3-architecture-decision-records)
4. [Format Comparison — YAML vs JSON vs XML](#4-format-comparison--yaml-vs-json-vs-xml)
5. [File Structure Options](#5-file-structure-options)
6. [Recommended Structure](#6-recommended-structure)
7. [HRF Schema Specification](#7-hrf-schema-specification)
8. [Identifier Strategy](#8-identifier-strategy)
9. [Calibration Data Representation](#9-calibration-data-representation)
10. [Workflows](#10-workflows)
11. [C# Client Integration](#11-c-client-integration)
12. [Document Revision History](#12-document-revision-history)

---

## 1. Context & Goals

### 1.1 Problem Statement

ACDB (`.acdb`) and AWSP (`.awsp`) files are binary and zipped-JSON formats respectively. They are not human-readable, cannot be meaningfully diffed in tools like Araxis Merge, and cannot be hand-edited without a dedicated tool.

Additionally, internal entity IDs (subgraph IDs, module instance IDs, container IDs) are file-local integers that are auto-generated and are **not stable across files**. A naive text dump of two different ACDB files would produce meaningless diff noise on every ID line.

The Human-Readable Format (HRF) solves this by providing:
- A stable, name-based representation that can be diffed between ACDB file versions
- A text format that developers and customers can hand-edit without special tooling
- A source-of-truth format that round-trips losslessly to and from ACDB binary

### 1.2 Business Goals

| Goal | Description |
|------|-------------|
| **Diffability** | Customers and vendors can compare two ACDB versions in Araxis Merge, Beyond Compare, or git diff |
| **Mergeability** | Three-way text merge (git or Araxis) can combine vendor updates with customer customizations |
| **Auditability** | Git history of HRF files shows exactly what changed between ACDB releases |
| **Editability** | Developers can hand-edit HRF to add/modify modules, calibration data, or structure |
| **Round-trip** | HRF → ACDB → HRF produces identical output; no data loss |

### 1.3 Relationship to Patch File and Diff-Merge

The HRF is a **full export** of an ACDB file — it represents the complete state. The diff-merge patch file (see `diff-merge-design.md` Section 9) represents a **delta** between two states. These are complementary:

- HRF is used for human review, version control, and authoring
- Patch file is used for programmatic delta computation and apply operations
- HRF can be used as input to generate a new ACDB, which is then compared using the diff-merge engine

---

## 2. Requirements

### 2.1 Functional Requirements

#### FR-1: HRF Export
**Description:** Export any uploaded ACDB/AWSP file pair to HRF format.

**Acceptance Criteria:**
- Output includes all DB content: module definitions, key/value/tag definitions, usecases, subgraphs, modules, calibration data (CKV + TKV + VCPM), containers, subsystems, links (intra and cross-subgraph), port details, and `isReadonly` annotations
- Export is deterministic: same DB content always produces identical HRF text (sorted keys, stable ordering)
- File-local unstable IDs (`system_id`, `instance_id`, `subgraph_id`) appear only as supplementary annotations, never as primary keys
- Exported via API: `GET /projects/:id/export/hrf`

#### FR-2: HRF Import
**Description:** Parse HRF and load into the database, equivalent to the existing upload-files workflow.

**Acceptance Criteria:**
- Hand-modified HRF imports correctly
- Git-merged or Araxis-merged HRF imports correctly
- Validation errors reported with precise location (file path, field name) for structural problems
- Import via API: `POST /projects/import/hrf` (multipart upload of root directory as zip, or single-file mode)

#### FR-3: HRF as Source of Truth
**Description:** Users maintain HRF files only. ACDB binary is a generated output.

**Acceptance Criteria:**
- HRF → ACDB → HRF round-trip produces identical HRF output
- Tool supports saving in either HRF or ACDB format
- HRF can be opened in a visual tool for editing (future scope)

### 2.2 Non-Functional Requirements

#### NFR-1: Losslessness
All information in the ACDB/AWSP database is representable in HRF. No field is silently dropped during export. Import reconstructs the full DB state.

#### NFR-2: Diffability
- Stable semantic identifiers used throughout (no file-local integer IDs as keys)
- Deterministic field ordering in all output files
- File structure split at subgraph granularity to enable folder-level diff in Araxis Merge

#### NFR-3: Editability
- Format hand-editable without special tooling
- Comments supported for developer annotations
- Format readable by non-experts with minimal domain knowledge

---

## 3. Architecture Decision Records

### ADR-001: HRF is the Primary Authoring Format

**Decision:** Users maintain HRF files as the primary source of truth. ACDB binary is a generated output, not an authoring artefact.

**Rationale:** ACDB binary files cannot be version-controlled, diffed, or merged with standard tools. HRF enables standard software engineering workflows (git, code review, three-way merge) to be applied to audio graph data.

**Consequences:** HRF export and import must be lossless. The import path must be as robust as the existing binary upload path.

**Status:** Accepted

---

### ADR-002: Stable Entity Identifiers — Definition Name + Graph Neighborhood for Modules

**Decision:**
- **Subgraph** — identified by `name`. The DB enforces `unique(name, file_system_id)`, so subgraph name is a reliable stable identifier within a file.
- **Module** — identified by `definition` (the module type name, e.g., `MODULE_FRAMEWORK_CORE`) within its subgraph. `definition` is stable across ACDB file versions because it refers to the module type, not the instance. When a subgraph contains multiple instances of the same definition type, `predecessors` and `successors` (lists of connected definition names derived from the link graph) are added as disambiguation fields. This mirrors the graph-neighborhood strategy in ADR-005 of the diff-merge design.
- **Alias** — retained as a human-readable label (`alias` field) that is unique within a subgraph by convention. Alias is used in link references within the same file (local convenience) but is **not** the stable identity key. On import, modules are located by `definition` + neighborhood, not by alias.
- **Usecase** — identified by `alias` at the HRF level. GKV is the authoritative identity for diff-merge operations and is always present.
- **Container** — identified by a stable `alias` field, referenced from modules.
- **File-local IDs** (`instance_id`, `subgraph_id`, `container_id`) appear only as supplementary read-only fields and are ignored on import.

**Rationale:** Module aliases are not guaranteed to be stable across vendor ACDB file versions. Using `definition` name as the primary key ensures that a module with a renamed alias shows only the `alias` field as changed in the diff, rather than appearing as a full remove + add. This is consistent with how the diff-merge patch file identifies modules (ADR-011 in diff-merge-design.md).

**Status:** Accepted

---

### ADR-003: Cross-Subgraph Links Defined at Usecase Level

**Decision:** Data-links and control-links whose source subgraph differs from the destination subgraph (`source_subgraph_system_id ≠ dest_subgraph_system_id`) are declared under the usecase, not inside either subgraph file. Intra-subgraph links (both endpoints in the same subgraph) are declared inside the subgraph file.

**Rationale:** A cross-subgraph link belongs to neither subgraph exclusively. Placing it at the usecase level avoids duplication and makes the usecase file the complete description of how its subgraphs connect to each other.

**Status:** Accepted

---

### ADR-004: Calibration Payloads as Decoded Key-Value

**Decision:** CKV, TKV, and VCPM parameter payloads are decoded to human-readable key-value pairs using `elements_structure` from the parameter definition. No hex or base64 blobs in HRF.

**Rationale:** Blobs cannot be diffed or hand-edited. The `elements_structure` field provides the schema needed to decode all known parameters. If `elements_structure` is absent for an edge-case parameter, export fails loudly rather than silently emitting undecoded binary.

**Consequences:** Export requires the parameter definition to be loaded alongside the payload. Import requires decoding the key-value back to binary using the same structure definition.

**Status:** Accepted

---

### ADR-005: Containers as Shared References

**Decision:** Containers are defined once in a top-level `containers.yaml` file. Module entries reference a container by its alias. Containers are not inlined per-subgraph.

**Rationale:** Containers are file-scoped and shared across subgraphs. Inlining them would cause duplication and make diffs of container properties noisy.

**Status:** Accepted

---

### ADR-006: HRF Serialization Format — YAML

**Decision:** YAML is the serialization format for HRF.

**Rationale:** See Section 4 for full comparison. YAML wins on every dimension relevant to the primary use case: human authoring, Araxis Merge diffability, hand editability, multi-line calibration data (block scalars), and native comment support. JSON Schema validation is applied at import time by converting YAML to JSON.

**Alternatives considered:** JSON (rejected: no comments, brace/quote noise, poor hand-editability), XML (rejected: was previous format, angle-bracket verbosity, poorest diffability).

**Status:** Accepted

---

### ADR-007: HRF File Structure — Directory Tree at Subgraph Granularity

**Decision:** HRF is a directory tree. Each subgraph is a separate YAML file. See Section 5 Option 1 for the full structure.

**Rationale:** Subgraph-level granularity enables Araxis Merge folder comparison to show exactly which subgraphs changed. Git history is per-subgraph. Each file is small (one subgraph with its modules and calibration data). A 1500-usecase ACDB with 5 SGs/UC produces ~7500 small files — manageable in any modern tool.

**Alternatives considered:** Single YAML file per ACDB (Option 2: portable but not folder-diffable, very large); JSON per-usecase (Option 3: machine-friendly but poor hand-editability).

**Status:** Accepted

---

## 4. Format Comparison — YAML vs JSON vs XML

### 4.1 Criterion Table

| Criterion | YAML | JSON | XML |
|-----------|------|------|-----|
| Human readability | ✅ Best | ✓ Acceptable | ❌ Worst |
| Hand editability | ✅ Natural | ✓ Error-prone (trailing commas) | ❌ Tedious |
| Comment support | ✅ Native `#` | ❌ None (workaround: `"_comment"`) | ✅ `<!-- -->` |
| Araxis/git diff quality | ✅ Clean, minimal noise | ✓ Noisier (punctuation changes) | ❌ Very noisy |
| Multi-line strings | ✅ Block scalars (`\|`) | ❌ Escaped `\n` | ✓ CDATA |
| Schema validation | ✓ Via JSON Schema after parse | ✅ Native JSON Schema | ✅ XSD / RelaxNG |
| Machine consumption | ✓ All languages have parsers | ✅ Native in JS/TS | ✓ Widely supported |
| TypeScript type generation | ✓ Via JSON Schema | ✅ Native | ✓ Via XSD |
| Deeply nested structures | ✅ Scales well | ✓ Visually cluttered | ❌ Very verbose |
| Shared references | ✅ YAML anchors | ❌ Must duplicate or use `$ref` | ✓ `id`/`idref` attributes |
| Prior art in audio/embedded | ❌ Uncommon | ✓ Common | ✅ Was previous HRF format |

**TOML** was also evaluated and eliminated: excellent for flat configuration, but structurally unsuitable for the three-to-five levels of nesting required here (usecase → subgraph → module → calibration key-value → parameters).

### 4.2 Side-by-Side Example: Same Subgraph in YAML vs JSON

The following example shows one subgraph (`SG_Playback`) with two modules, intra-subgraph data links, and calibration data (CKV with two key-value contexts).

---

#### YAML (Option 1 — recommended)

```yaml
# SG_Playback.yaml
name: SG_Playback
is_exported: true

vcpm_instances:
  - definition: VCPM_Audio

modules:
  - definition: MODULE_FRAMEWORK_CORE
    alias: MFC1
    container: container_spr
    is_readonly: false
    properties:
      stack_size: 4096
    calibration:
      - keys:
          device: headphone
          stream_type: playback
        parameters:
          enable: 1
          gain: 0x1000
          num_channels: 2
      - keys:
          device: speaker
          stream_type: playback
        parameters:
          enable: 1
          gain: 0x0800
          num_channels: 2
    tags:
      - tag: TAG_STREAM_MARKER
        keys:
          device: headphone
        parameters:
          marker_id: 5
          tag_version: 1

  - definition: IIR_FILTER
    alias: IIR1
    container: container_spr
    is_readonly: false
    calibration:
      - keys:
          device: headphone
          stream_type: playback
        parameters:
          num_biquads: 4
          coefficients: [ 1.0, -1.5, 0.7, 0.0, 0.0 ]

links:
  - type: data
    source: MFC1.out_port_0
    dest: IIR1.in_port_0
  - type: data
    source: MFC1.out_port_1
    dest: IIR1.in_port_1
```

---

#### JSON (for comparison)

```json
{
  "name": "SG_Playback",
  "is_exported": true,
  "vcpm_instances": [
    { "definition": "VCPM_Audio" }
  ],
  "modules": [
    {
      "definition": "MODULE_FRAMEWORK_CORE",
      "alias": "MFC1",
      "container": "container_spr",
      "is_readonly": false,
      "properties": {
        "stack_size": 4096
      },
      "calibration": [
        {
          "keys": {
            "device": "headphone",
            "stream_type": "playback"
          },
          "parameters": {
            "enable": 1,
            "gain": 4096,
            "num_channels": 2
          }
        },
        {
          "keys": {
            "device": "speaker",
            "stream_type": "playback"
          },
          "parameters": {
            "enable": 1,
            "gain": 2048,
            "num_channels": 2
          }
        }
      ],
      "tags": [
        {
          "tag": "TAG_STREAM_MARKER",
          "keys": {
            "device": "headphone"
          },
          "parameters": {
            "marker_id": 5,
            "tag_version": 1
          }
        }
      ]
    },
    {
      "definition": "IIR_FILTER",
      "alias": "IIR1",
      "container": "container_spr",
      "is_readonly": false,
      "calibration": [
        {
          "keys": {
            "device": "headphone",
            "stream_type": "playback"
          },
          "parameters": {
            "num_biquads": 4,
            "coefficients": [ 1.0, -1.5, 0.7, 0.0, 0.0 ]
          }
        }
      ]
    }
  ],
  "links": [
    { "type": "data", "source": "MFC1.out_port_0", "dest": "IIR1.in_port_0" },
    { "type": "data", "source": "MFC1.out_port_1", "dest": "IIR1.in_port_1" }
  ]
}
```

---

**Observations from the comparison:**

- YAML is **~30% shorter** for the same content (no quotes on keys, no braces, no trailing commas)
- JSON requires **every string quoted** — values like `headphone`, `playback`, `MFC1.out_port_0` are noisier in diffs
- YAML supports `# comments` inline — JSON requires the `"_comment"` workaround field
- When a single calibration parameter changes (e.g., `gain: 0x1000` → `gain: 0x0C00`), YAML produces a one-line diff; JSON produces the same but surrounded by more punctuation noise
- YAML block scalars handle future multi-line data (e.g., coefficient arrays, string descriptions) naturally; JSON requires escaped newlines
- Both are equally machine-parseable; the YAML parser adds one dependency (`js-yaml` or equivalent)

---

## 5. File Structure Options

### Option 1: YAML Directory Tree — Maximum Diffability ✅ Recommended

```
<project-export>/
  metadata.yaml
  definitions/
    spf-modules.yaml
    vcpm-modules.yaml
    driver-modules.yaml
    keys.yaml
    tags.yaml
  containers.yaml
  subsystems.yaml
  usecases/
    <uc-alias>/
      usecase.yaml
      subgraphs/
        <sg-name>.yaml
```

**Pros:**
- Araxis Merge / Beyond Compare folder diff shows exactly which subgraphs changed
- Git history is per-subgraph — `git log usecases/UC_Headphone/subgraphs/SG_Playback.yaml` shows all changes to that subgraph
- Each file is small (one subgraph ≈ 5–50KB even with full calibration data)
- Merge conflicts are isolated to the specific subgraph file that changed
- 1500 UCs × 5 SGs = ~7500 files — manageable in any modern IDE or diff tool

**Cons:**
- Many files — tooling needed to assemble into a single ACDB (handled by import API)
- Sharing the export requires zip/tar of the directory
- Directory renames break `git blame` continuity (same as any refactor in source code)

**Best for:** Teams version-controlling ACDB files in git, using Araxis/Beyond Compare for review, wanting granular blame history.

---

### Option 2: Single YAML File per ACDB

```
<project-name>.arc.yaml
```

All content in one file. YAML anchors (`&container_spr`) and aliases (`*container_spr`) represent shared containers.

**Pros:**
- Single portable file — email, attach to ticket, commit as one unit
- No directory structure to manage or zip
- Simpler import tooling (one file in, one ACDB out)

**Cons:**
- Very large files (50–200MB for 1500 usecases with full calibration data)
- A changed calibration value appears as one diff line buried 80,000 lines into the file
- Cannot use Araxis folder diff
- YAML anchors can confuse some diff tools and editors

**Best for:** Small ACDBs, one-off exchanges, quick sharing where git ergonomics do not matter.

---

### Option 3: JSON with JSON Schema (One file per usecase)

```
<project-export>/
  manifest.json
  definitions.json
  containers.json
  subsystems.json
  usecases/
    <uc-alias>.json
```

Subgraphs are inlined into the usecase file (not separate files). JSON Schema enforces structure at import time. TypeScript types can be auto-generated from the schema.

**Pros:**
- Strict machine-validated contracts — import errors are precise and schema-located
- TypeScript type generation eliminates a class of import parser bugs
- Native to JS/TS toolchain; no YAML parser dependency
- One file per usecase (1500 files) keeps diffs manageable at usecase level

**Cons:**
- No comment support (must use `"_comment"` convention)
- Brace/quote noise makes hand editing tedious and error-prone
- Multi-line calibration data requires escaped strings
- No Araxis folder diff at subgraph level (subgraphs inlined into usecase file)

**Best for:** Teams who want strict schema contracts, primarily generate/consume HRF programmatically, or use automated tooling pipelines.

---

### Option Comparison Summary

| Criterion | Option 1: YAML Directory Tree | Option 2: Single YAML | Option 3: JSON + Schema |
|-----------|-------------------------------|----------------------|------------------------|
| Araxis folder diff | ✅ Subgraph-level | ❌ Not applicable | ✓ Usecase-level |
| Hand editability | ✅ | ✅ | ❌ |
| Git blame granularity | ✅ Per-subgraph | ❌ Per-file only | ✓ Per-usecase |
| File count (1500 UCs, 5 SGs) | ~7500 | 1 | ~1500 |
| Single-file portability | ❌ Needs zip | ✅ | ✓ |
| Schema validation | ✓ Via JSON Schema | ✓ Via JSON Schema | ✅ Native |
| Import tooling complexity | Medium | Low | Medium |
| Comment support | ✅ | ✅ | ❌ |
| **Recommended** | ✅ **Primary** | For small ACDBs / quick sharing | When tooling > readability |

---

## 6. Recommended Structure

Full directory layout with file responsibilities:

```
<project-export>/                         # root — one directory per ACDB/AWSP pair
  metadata.yaml                           # AWSP: file header, versions, codec info, OEM info
  definitions/
    spf-modules.yaml                      # AWSP: SpfModuleDefinition list (name, params, ports, attributes)
    vcpm-modules.yaml                     # AWSP: VcpmModuleDefinition list
    driver-modules.yaml                   # AWSP: DriverModuleDefinition list
    keys.yaml                             # AWSP: arc_keys + arc_values (GKV vocabulary)
    tags.yaml                             # AWSP: tag_definitions + tag_key_def_links
  containers.yaml                         # ACDB: all container instances with type and property data
  subsystems.yaml                         # ACDB: subsystem definitions with filtered-key refs
  usecases/
    <uc-alias>/
      usecase.yaml                        # ACDB: GKV, categories, subgraph-pairs, cross-SG links
      subgraphs/
        <sg-name>.yaml                    # ACDB: modules, intra-SG links, CKV, TKV, VCPM
```

**Naming rules:**
- Directory and file names use the entity `name` or `alias` field, lowercased, spaces replaced with `_`
- If a name contains characters invalid for a file system path, the name is percent-encoded
- The export manifest (`metadata.yaml`) records the mapping from file path to entity alias for disambiguation

---

## 7. HRF Schema Specification

### 7.1 `metadata.yaml`

```yaml
file_name: vendor_v2.acdb
description: Vendor reference ACDB v2.1
type: ACDB
header_version: 3
acdb_version:
  major: 2
  minor: 1
  revision: 0
  cpl_info: 0
modified_date: 1748649600
codec_infos: []
oem_info: ""
```

### 7.2 `definitions/keys.yaml`

```yaml
keys:
  - key_id: 1
    name: DEVICE
    key_enum_name: ar_device_type
    is_graph_key: true
    is_calibration_key: false
    values:
      - value_id: 1
        name: headphone
        enum_value: DEVICE_HEADPHONE
      - value_id: 2
        name: speaker
        enum_value: DEVICE_SPEAKER
  - key_id: 2
    name: STREAM_TYPE
    is_graph_key: true
    is_calibration_key: true
    values:
      - value_id: 10
        name: playback
      - value_id: 11
        name: capture
```

### 7.3 `containers.yaml`

```yaml
containers:
  - alias: container_spr
    type: SPF
    container_id: 1       # supplementary, ignored on import
    properties:
      - property: CONTAINER_PROP_HEAP_ID
        payload:
          heap_id: 0
  - alias: container_default
    type: SPF
    container_id: 2
    properties: []
```

### 7.4 `subsystems.yaml`

```yaml
subsystems:
  - name: SS_Audio
    filtered_keys:
      - DEVICE
      - STREAM_TYPE
  - name: SS_Voice
    filtered_keys:
      - DEVICE
      - CALL_TYPE
```

### 7.5 `usecases/<uc-alias>/usecase.yaml`

```yaml
alias: UC_Headphone_Playback
alias_id: 101              # supplementary
gkv:
  - key: DEVICE
    value: headphone
  - key: STREAM_TYPE
    value: playback
categories:
  - audio
  - playback
is_readonly: false
subgraph_pairs:
  - source: SG_Playback
    dest: SG_Output
cross_subgraph_links:
  - type: data
    source: SG_Playback.MFC1.out_port_1
    dest: SG_Output.SINK1.in_port_0
  - type: control
    peer_a: SG_Playback.MFC1.ctrl_port_0
    peer_b: SG_Output.SINK1.ctrl_port_0
    heap_id: 2
```

### 7.6 `usecases/<uc-alias>/subgraphs/<sg-name>.yaml`

```yaml
name: SG_Playback
subgraph_id: 12            # supplementary, ignored on import
is_exported: true
is_readonly: false

vcpm_instances:
  - definition: VCPM_Audio
    calibration:
      - keys:
          device: headphone
        parameters:
          volume_level: 100

modules:
  - alias: MFC1
    definition: MODULE_FRAMEWORK_CORE
    instance_id: 1001      # supplementary, ignored on import
    container: container_spr
    is_readonly: false
    predecessors: []
    successors: [IIR_FILTER]
    properties:
      - property: MODULE_PROP_STACK_SIZE
        payload:
          stack_size: 4096
    calibration:
      - keys:
          device: headphone
          stream_type: playback
        parameters:
          enable: 1
          gain: 0x1000
          num_channels: 2
      - keys:
          device: speaker
          stream_type: playback
        parameters:
          enable: 1
          gain: 0x0800
          num_channels: 2
    tags:
      - tag: TAG_STREAM_MARKER
        keys:
          device: headphone
        parameters:
          marker_id: 5

  - alias: IIR1
    definition: IIR_FILTER
    instance_id: 1002      # supplementary
    container: container_spr
    is_readonly: false
    calibration:
      - keys:
          device: headphone
          stream_type: playback
        parameters:
          num_biquads: 4
          coefficients: [ 1.0, -1.5, 0.7, 0.0, 0.0 ]

links:
  - type: data
    source: MFC1.out_port_0
    dest: IIR1.in_port_0
  - type: data
    source: MFC1.out_port_1
    dest: IIR1.in_port_1
  - type: control
    peer_a: MFC1.ctrl_port_0
    peer_b: IIR1.ctrl_port_0
    heap_id: 1
```

---

## 8. Identifier Strategy

### 8.1 Stable vs Unstable IDs

| Entity | Stable Identifier (HRF key) | Supplementary only (ignored on import) |
|--------|----------------------------|-----------------------------------------|
| Usecase | `alias` | `alias_id`, `system_id` |
| Subgraph | `name` | `subgraph_id`, `system_id` |
| Module | `definition` + graph neighborhood | `alias`, `instance_id`, `system_id` |
| Container | `alias` | `container_id`, `system_id` |
| Subsystem | `name` | `system_id` |
| Module Definition | `name` (from `spf_module_definitions.name`) | `module_definition_id`, `system_id` |
| Key | `name` (from `arc_keys.name`) | `key_id` |
| Value | `name` (from `arc_values.name`) | `value_id` |
| Tag | `name` (from `tag_definitions.name`) | `tag_id` |

**Rule:** On export, supplementary fields are written for traceability. On import, supplementary fields are ignored — entities are located by their stable identifier.

### 8.2 Module Identity and Neighborhood Disambiguation

A module's stable identity is its `definition` type name (e.g., `MODULE_FRAMEWORK_CORE`). Definition names are type-level identifiers that are stable across ACDB file versions. The `alias` field is retained as a human-readable label and is unique within a subgraph by convention, but it is **not** the key used for cross-file matching.

When a subgraph contains only **one instance** of a given definition type, `definition` alone identifies it:

```yaml
modules:
  - definition: IIR_FILTER
    alias: IIR1                  # informational — not the key
    container: container_spr
    ...
```

When a subgraph contains **multiple instances of the same definition type**, `predecessors` and `successors` are added to disambiguate. These list the `definition` names of directly connected modules, derived from the `links` section. This is the same graph-neighborhood strategy used in the diff-merge patch file (ADR-005, diff-merge-design.md):

```yaml
modules:
  - definition: MODULE_FRAMEWORK_CORE
    alias: MFC1                  # informational label
    predecessors: []             # no upstream modules
    successors: [IIR_FILTER]     # connects to IIR downstream
    ...

  - definition: MODULE_FRAMEWORK_CORE
    alias: MFC2
    predecessors: [ENCODER]      # connects from ENCODER upstream — disambiguates from MFC1
    successors: [SINK]
    ...
```

**Diff behaviour:** When a vendor renames `alias: MFC1` to `alias: MFC_Primary` in a new release, the diff shows only the `alias` line changed — the module is still matched by `definition` + neighborhood. Without this strategy, the entire module block would appear as remove + add, burying the real calibration or property changes inside the noise.

**Export ordering:** Modules within a subgraph are exported sorted by `definition` name, then by topological position within the link graph. This produces deterministic YAML output for stable diffs.

### 8.3 Link Port Reference Syntax

Links use **alias** as the module reference within a file. Alias is unique within a subgraph by convention and is a local convenience — on import it is resolved to the module's stable identity (`definition` + neighborhood).

```yaml
links:
  - type: data
    source: MFC1.out_port_0      # <alias>.<port-name>
    dest: IIR1.in_port_0

  - type: data
    source: MFC1.audio_out       # named port variant
    dest: IIR1.audio_in
```

Port names come from `data_port_definitions.name`. If a port has no name, fall back to `port_<port-id>`.

Cross-subgraph links (in `usecase.yaml`) prefix the subgraph name: `<sg-name>.<module-alias>.<port-name>`.

---

## 9. Calibration Data Representation

### 9.1 CKV (Calibration Key-Value)

Each CKV entry is a combination of a key-value context (which device/stream/etc. this calibration applies to) and a set of parameter payloads decoded from binary using `elements_structure`.

```yaml
calibration:
  - keys:
      device: headphone        # arc_key.name: arc_value.name
      stream_type: playback
    parameters:                # decoded from ckv_parameter_payload blobs
      enable: 1
      gain: 0x1000
      filter_order: 4
```

### 9.2 TKV (Tag Key-Value)

TKV entries are per-tag calibration. The `tag` field is the tag definition name.

```yaml
tags:
  - tag: TAG_STREAM_MARKER
    keys:
      device: headphone
    parameters:
      marker_id: 5
```

### 9.3 VCPM Calibration

VCPM instances live at the subgraph level and have their own CKV structure.

```yaml
vcpm_instances:
  - definition: VCPM_Audio
    calibration:
      - keys:
          device: headphone
        parameters:
          volume_level: 100
          mute: 0
```

### 9.4 Parameter Value Encoding

| Data type | HRF representation | Example |
|-----------|-------------------|---------|
| Integer | Decimal or hex (`0x` prefix) | `gain: 0x1000` |
| Float | IEEE 754 decimal | `coeff: 1.5` |
| Boolean | `true` / `false` | `enable: true` |
| Array | YAML inline sequence | `coefficients: [1.0, -1.5, 0.7]` |
| Enum | String name from enum definition | `mode: MODE_STEREO` |
| Struct | YAML mapping (nested) | `config:\n  width: 16\n  depth: 32` |

---

## 10. Workflows

### 10.1 Export ACDB to HRF

```
1. User requests export
   GET /arc-api/v1/projects/:id/export/hrf

2. System reads all DB content for the project's file
   - Loads: files, definitions, keys, tags, containers, subsystems, usecases, subgraphs, modules, CKV, TKV, VCPM

3. System decodes all BLOB payloads using elements_structure from parameter definitions

4. System serializes to directory tree:
   - Deterministic field ordering (alphabetical within sections)
   - Supplementary IDs included as read-only annotations
   - isReadonly flags included

5. System returns zip archive of the directory tree
   (or streams individual files via multipart response)
```

### 10.2 Import HRF to ACDB

```
1. User uploads HRF (zip of directory tree or single .arc.yaml)
   POST /arc-api/v1/projects/import/hrf

2. System parses YAML files, validates against JSON Schema

3. System resolves all stable name references to DB entities:
   - Key names → arc_keys system_id
   - Value names → arc_values system_id
   - Definition names → spf_module_definitions system_id
   - Container aliases → containers system_id

4. System inserts entities via BulkImportRepository
   (same path as existing upload-file workflow)

5. System encodes decoded key-value parameters back to BLOB payloads
   using elements_structure

6. Returns project system_id and any validation warnings
```

### 10.3 Araxis Merge Diff Workflow

```
1. Export version A of ACDB to hrf-v1/ directory
2. Export version B of ACDB to hrf-v2/ directory
3. Open Araxis Merge → Folder comparison → hrf-v1/ vs hrf-v2/
4. Araxis shows:
   - New files: newly added subgraphs or usecases
   - Deleted files: removed subgraphs or usecases
   - Changed files: subgraphs with modified modules or calibration
5. For each changed file, Araxis shows line-level diff within the YAML
   - Changed calibration value: one line diff
   - Added module: block insertion
   - Changed link: one line diff
```

### 10.4 Three-Way Merge Workflow (Vendor Update + Customer Customization)

```
1. Export base vendor ACDB to hrf-base/ (common ancestor)
2. Export new vendor ACDB to hrf-ref/ (updated reference)
3. Export customer ACDB to hrf-target/ (customer customizations)

4. Araxis three-way merge (or git merge-tool):
   Base: hrf-base/
   Reference: hrf-ref/    (vendor changes)
   Target: hrf-target/    (customer changes)

5. Araxis shows which changes from vendor conflict with customer changes
   at the YAML line level within each subgraph file

6. User resolves conflicts file by file

7. Merged HRF imported back to ACDB:
   POST /arc-api/v1/projects/import/hrf
```

---

## 11. C# Client Integration

### 11.1 Overview

The HRF export endpoint is consumed by a WPF/C# desktop application on the same machine. Because HRF export is an infrequent, opt-in operation, the server is started on-demand, used for a single export, and immediately shut down. No background process runs otherwise.

```
User triggers export
  → C# spawns arc-server.exe
  → polls /arc-api/health until ready
  → uploads ACDB/AWSP via REST
  → requests HRF zip via REST
  → kills process + deletes temp data directory
  → saves zip to user-chosen path
```

---

### 11.2 Bundling the Server into a Single Executable

The NestJS server is packaged into a self-contained Windows executable using `pkg`. This removes the requirement for Node.js to be installed on the end user's machine.

**Prerequisites:**

```bash
pnpm add -D pkg
```

**Build and bundle steps:**

```bash
# 1. Compile TypeScript
pnpm --filter @arc/api build

# 2. Bundle into a single Windows executable
npx pkg packages/api/dist/main.js \
  --targets node18-win-x64 \
  --output dist/arc-server.exe \
  --assets "packages/infrastructure/persistence/src/**/*.js"
```

> **Note:** `node-sea` (Node.js 21+ official single-executable feature) is a future alternative to `pkg` if the project upgrades to Node 21 or later.

**Required TypeScript change — `DATA_DIR` env var:**

The server must write its SQLite database to a configurable directory so each run is isolated and the temp data can be cleaned up after use. Update the TypeORM database path in `packages/api/src/app.module.ts`:

```typescript
// Before
database: 'arc.db',

// After
database: process.env['DATA_DIR']
  ? path.join(process.env['DATA_DIR'], 'arc.db')
  : 'arc.db',
```

**Required TypeScript change — health endpoint:**

Add a health check endpoint so the C# client can poll until the server is ready to accept requests:

```typescript
// packages/api/src/presentation/rest/modules/health/health.controller.ts
@Controller('arc-api')
export class HealthController {
  @Get('health')
  health() { return { status: 'ok' }; }
}
```

---

### 11.3 C# Client Library

Create a .NET class library (`ArcCreator.HrfExport`) that the WPF application references. It contains two classes: `ArcServerProcess` (process lifecycle) and `ArcHrfClient` (REST calls).

```
ArcCreator.HrfExport/
  ArcServerProcess.cs      // start, health-poll, kill, temp dir cleanup
  ArcHrfClient.cs          // upload files, export HRF zip
  Dto/
    ApiResult.cs
    ProjectInfoDto.cs
```

---

### 11.4 Starting the Server

`ArcServerProcess` spawns `arc-server.exe`, passes `PORT` and `DATA_DIR` as environment variables, and polls the health endpoint until the server is ready.

```csharp
public sealed class ArcServerProcess : IAsyncDisposable
{
    private Process? _process;
    private readonly string _exePath;
    private readonly string _dataDir;
    private readonly int _port;

    public ArcServerProcess(
        string exePath = "arc-server.exe",
        int port = 3000,
        string? dataDir = null)
    {
        _exePath = exePath;
        _port = port;
        // Isolated temp folder per run — deleted on dispose
        _dataDir = dataDir
            ?? Path.Combine(Path.GetTempPath(), $"arc-{Guid.NewGuid():N}");
    }

    public async Task StartAsync(CancellationToken ct = default)
    {
        Directory.CreateDirectory(_dataDir);

        var info = new ProcessStartInfo
        {
            FileName = _exePath,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        info.EnvironmentVariables["PORT"]     = _port.ToString();
        info.EnvironmentVariables["DATA_DIR"] = _dataDir;

        _process = Process.Start(info)
            ?? throw new InvalidOperationException("Failed to start arc-server.exe");

        _process.OutputDataReceived += (_, e) => Debug.WriteLine($"[arc] {e.Data}");
        _process.BeginOutputReadLine();

        await WaitForReadyAsync(ct);
    }

    private async Task WaitForReadyAsync(CancellationToken ct, int timeoutMs = 15_000)
    {
        using var http = new HttpClient();
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);

        while (DateTime.UtcNow < deadline)
        {
            ct.ThrowIfCancellationRequested();
            try
            {
                var resp = await http.GetAsync(
                    $"http://localhost:{_port}/arc-api/health", ct);
                if (resp.IsSuccessStatusCode) return;
            }
            catch (HttpRequestException) { /* not ready yet */ }

            await Task.Delay(200, ct);
        }

        throw new TimeoutException(
            $"arc-server.exe did not become ready within {timeoutMs}ms.");
    }
}
```

---

### 11.5 Calling the API

`ArcHrfClient` wraps the two REST calls needed for export: upload the source files to create a project, then download the HRF zip.

```csharp
public sealed class ArcHrfClient
{
    private readonly HttpClient _http;

    public ArcHrfClient(string baseUrl)
    {
        _http = new HttpClient { BaseAddress = new Uri(baseUrl) };
    }

    /// <summary>Uploads an ACDB/AWSP file pair and returns the new project ID.</summary>
    public async Task<string> UploadFilesAsync(
        string acdbPath,
        string awspPath,
        CancellationToken ct = default)
    {
        using var form = new MultipartFormDataContent();
        form.Add(new ByteArrayContent(await File.ReadAllBytesAsync(acdbPath, ct)),
            "acdbFile", Path.GetFileName(acdbPath));
        form.Add(new ByteArrayContent(await File.ReadAllBytesAsync(awspPath, ct)),
            "awspFile", Path.GetFileName(awspPath));

        var resp = await _http.PostAsync(
            "arc-api/v1/projects/offline/upload-files", form, ct);
        resp.EnsureSuccessStatusCode();

        var body = await resp.Content.ReadFromJsonAsync<ApiResult<ProjectInfoDto>>(ct)
            ?? throw new InvalidOperationException("Empty response from server.");

        return body.Data.ProjectId;
    }

    /// <summary>Exports the project to HRF and returns the raw zip bytes.</summary>
    public async Task<byte[]> ExportHrfAsync(
        string projectId,
        CancellationToken ct = default)
    {
        var resp = await _http.GetAsync(
            $"arc-api/v1/projects/{projectId}/export/hrf", ct);
        resp.EnsureSuccessStatusCode();

        return await resp.Content.ReadAsByteArrayAsync(ct);
    }
}
```

Minimal DTO classes:

```csharp
public record ApiResult<T>(T Data);
public record ProjectInfoDto(string ProjectId);
```

---

### 11.6 Killing the Server and Cleaning Up

`DisposeAsync` kills the process and deletes the isolated temp data directory. Implement `IAsyncDisposable` so `await using` guarantees cleanup even when an exception is thrown mid-export.

```csharp
// Inside ArcServerProcess
public async ValueTask DisposeAsync()
{
    // 1. Kill the server process
    if (_process is { HasExited: false })
    {
        _process.Kill(entireProcessTree: true);
        await _process.WaitForExitAsync();
    }
    _process?.Dispose();

    // 2. Delete the temp data directory (SQLite db, uploaded files)
    if (Directory.Exists(_dataDir))
        Directory.Delete(_dataDir, recursive: true);
}
```

---

### 11.7 Full End-to-End Usage

Complete export flow from a WPF view model:

```csharp
public async Task ExportHrfAsync(
    string acdbPath,
    string awspPath,
    string outputZipPath,
    CancellationToken ct = default)
{
    await using var server = new ArcServerProcess(
        exePath: Path.Combine(AppContext.BaseDirectory, "arc-server.exe"));

    await server.StartAsync(ct);                    // spawn + wait for /health (~2-3s)

    var client = new ArcHrfClient("http://localhost:3000");
    string projectId = await client.UploadFilesAsync(acdbPath, awspPath, ct);
    byte[] zip       = await client.ExportHrfAsync(projectId, ct);

    await File.WriteAllBytesAsync(outputZipPath, zip, ct);
}   // ← server killed, DATA_DIR deleted here (await using)
```

---

### 11.8 Edge Cases and Considerations

| Concern | Mitigation |
|---------|-----------|
| Port 3000 already in use | Pick a random free port: create a `TcpListener(IPAddress.Loopback, 0)`, start it, read `.LocalEndpoint.Port`, stop it, then pass that port to `ArcServerProcess` |
| Two concurrent export calls | Each `ArcServerProcess` gets its own `DATA_DIR` and port — they are fully independent |
| Server crashes mid-export | `DisposeAsync` checks `HasExited` before killing; `DATA_DIR` is always deleted regardless |
| `arc-server.exe` not found | Throw `FileNotFoundException` with the full resolved path in the message |
| Large ACDBs (export takes >100s) | Set `_http.Timeout = TimeSpan.FromMinutes(10)` on `ArcHrfClient` construction |
| Antivirus blocking the unsigned exe | Sign `arc-server.exe` with your code-signing certificate in the build pipeline |

---

## 12. Document Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-06-15 | Architecture Team | Initial HRF design document |

---

*End of Document*
