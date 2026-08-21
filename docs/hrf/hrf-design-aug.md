<!--
Copyright (c) Qualcomm Technologies, Inc. and/or its subsidiaries.
SPDX-License-Identifier: BSD-3-Clause
-->

# HRF (Human-Readable Format) Design Document

**Date:** August 2026
**Status:** Draft — pending user approval

---

## Table of Contents

1. [Context and Goals](#1-context-and-goals)
2. [Requirements](#2-requirements)
3. [Directory Structure](#3-directory-structure)
4. [JSON Schemas with Examples](#4-json-schemas-with-examples)
5. [Identifier Strategy](#5-identifier-strategy)
6. [Calibration Encoding](#6-calibration-encoding)
7. [Link Representation](#7-link-representation)
8. [Export Service Design](#8-export-service-design)
9. [Import Service Design](#9-import-service-design)
10. [Determinism Rules](#10-determinism-rules)
11. [Verification](#11-verification)
12. [New File Locations](#12-new-file-locations)

---

## 1. Context and Goals

### 1.1 Problem Statement

ACDB (`.acdb`) and AWSP (`.awsp`) files are opaque to diff tools and manual inspection:

- ACDB is binary — git shows it as a changed blob; individual changes are invisible.
- AWSP is a zipped JSON aggregate — even unzipped, one large JSON file per section makes PR reviews impractical.

Audio configuration teams need to:
- Review changes in pull requests with line-level human-readable diffs.
- Hand-edit calibration data, module properties, or graph structure without going through a GUI.
- Store project snapshots in git with meaningful per-subgraph history.
- Three-way merge vendor ACDB updates with customer customizations.

### 1.2 What HRF Is

HRF is a deterministic directory tree of small JSON files — one file per subgraph, one file per module's calibration — where every file is independently reviewable, diffable, and hand-editable. A project exported to HRF and re-imported must produce an identical DB state (FR-09 round-trip fidelity).

### 1.3 Relationship to Existing Features

```
Upload:   ACDB + AWSP  --[UploadFileOrchestrator]--> DB
Download: DB           --[AwspFileSerializer]-------> AWSP
Export:   DB           --[HrfExportOrchestrator]----> ZIP of JSON files  (NEW)
Import:   ZIP of JSON  --[HrfImportOrchestrator]----> DB                 (NEW)
```

HRF export parallels download-file but produces many small files instead of one binary. HRF import parallels upload-file but reads JSON instead of binary chunks. Both reuse all existing query services and inserter infrastructure.

### 1.4 Format Choice

**JSON** is the serialization format (FR-10). The serializer layer (`HrfFileSerializer`) is isolated so YAML can be swapped in later with a one-line change — same directory structure, same identifiers, same data model.

---

## 2. Requirements

| ID | Requirement |
|----|-------------|
| FR-01 | `GET /projects/:id/export/hrf` returns a ZIP archive with `Content-Type: application/zip` |
| FR-02 | Export covers ALL DB content: header, definitions (keys, tags, SPF/VCPM/driver modules), containers, subsystems, drivers, module-manager, subgraphs (structure + SGKV + VCPM calibration), module CKV/TKV, and usecases |
| FR-03 | Export is deterministic: identical DB state produces byte-for-byte identical ZIP archive |
| FR-04 | No DB-internal `systemId` as a primary key in any file; integer IDs may appear as informational supplementary fields |
| FR-05 | Module stable key is `<definitionName>_<N>` where N is the 1-based topological rank within the subgraph (upstream sources = rank 1) |
| FR-06 | Calibration payloads decoded using `elementsStructure` from parameter definitions; export fails loudly if a payload exists but `elementsStructure` is absent |
| FR-07 | `POST /projects/import/hrf` accepts a ZIP body, parses JSON files, resolves names to DB system IDs, inserts via BulkImportRepository |
| FR-08 | Import is continue-on-error: all parse/resolve/insert failures collected with `{ file, field, message }` and returned in the response |
| FR-09 | Round-trip fidelity: export project → import HRF → export again produces byte-for-byte identical output |
| FR-10 | Format is JSON; YAML swap is isolated to the serializer layer |

### Out of Scope

- YAML format (swap is isolated to serializer — one PR later)
- Visual editor, C# client, server bundling as `.exe`
- Patch file / diff-merge engine (separate `diff-merge-design.md`)
- Incremental or partial exports
- Single-file option (`.arc.json`)

---

## 3. Directory Structure

```
<project-name>/
  metadata.json                    File header (ACDB version, codec, OEM)
  definitions/
    keys.json                      Key/value vocabulary (arc_keys + arc_values)
    tags.json                      Tag definitions + key links
    spf-modules.json               SPF module type catalog
    vcpm-modules.json              VCPM module type catalog
    driver-modules.json            Driver module type catalog
  containers.json                  Container instances + property data
  subsystems.json                  Subsystem flat list with parent references
  drivers.json                     Driver module instances + DKV calibration
  module-manager.json              CAPI registration entries
  subgraphs/
    <sg-name>/
      subgraph.json                Structure: module list, intra-SG links,
                                   SGKV, VCPM instances + VCPM CKV
      modules/
        <module-key>.json          CKV + TKV for one SPF module instance
  usecases/
    <uc-alias>.json                GKV, subgraph membership, subgraph pairs,
                                   cross-SG data links, cross-SG control links
```

**File responsibilities:**

| File | Source tables |
|------|--------------|
| `metadata.json` | `arc_db_files` |
| `definitions/keys.json` | `arc_keys`, `arc_values` |
| `definitions/tags.json` | `tag_definitions`, `tag_key_def_links` |
| `definitions/spf-modules.json` | `spf_module_definitions` + sub-tables |
| `definitions/vcpm-modules.json` | `vcpm_module_definitions` + sub-tables |
| `definitions/driver-modules.json` | `driver_module_definitions` + sub-tables |
| `containers.json` | `containers`, `container_property_data` |
| `subsystems.json` | `subsystems`, `subsystem_filtered_keys_key_definition` |
| `drivers.json` | `driver_modules`, `dkv`, `dkv_values`, `dkv_parameter_payload` |
| `module-manager.json` | `module_manager_data` |
| `subgraphs/<sg>/subgraph.json` | `subgraphs`, `sgkv`, `sgkv_values`, `vcpm_instances`, `vcpm_ckv`, `vcpm_ckv_values`, `vcpm_parameter_payload`, `spf_modules`, `spf_module_properties_data`, `nodes`, `data_ports`, `control_ports`, intra-SG `data_links`, `control_links` |
| `subgraphs/<sg>/modules/<key>.json` | `ckv`, `ckv_values`, `ckv_parameter_payload`, `tkv`, `tkv_values`, `tkv_parameter_payload` |
| `usecases/<alias>.json` | `use_cases`, `use_case_subgraphs`, `use_case_subgraph_pairs`, cross-SG `data_links`, `control_links` |

**Key structural rules:**

- Subgraphs are **top-level** and shared across usecases — not nested under usecases.
- Each usecase is a **single flat file** referencing subgraphs by name.
- `subgraph.json` holds module structure and VCPM calibration — **no SPF module CKV/TKV inline**.
- Each module's CKV + TKV live in a dedicated `modules/<key>.json` file.
- Intra-SG links → `subgraph.json`; cross-SG links → `usecase.json`.

---

## 4. JSON Schemas with Examples

### 4.1 `metadata.json`

```json
{
  "hrfVersion": "1.0",
  "fileName": "myproject.acdb",
  "description": "Main audio config",
  "headerVersion": 1,
  "acdbVersion": {
    "major": 35,
    "minor": 1,
    "revision": 0,
    "cplInfo": 0
  },
  "codecInfos": [
    { "name": "WCD9380", "version": "1.0" }
  ],
  "modifiedDate": 1722470400,
  "oemInfo": "QTI"
}
```

`hrfVersion` is hardcoded `"1.0"` by the exporter. `codecInfos` is `JSON.parse(ArcDbFileRow.codecInfos)`.

---

### 4.2 `definitions/keys.json`

Root array sorted by `name` ASC. `values` array within each key sorted by `valueId` ASC.

```json
[
  {
    "name": "StreamType",
    "keyId": 4096,
    "enumMember": "ACDB_STREAM_TYPE",
    "enumName": "acdb_stream_type_t",
    "description": "Audio stream type selector",
    "isVoice": false,
    "isDynamic": false,
    "isCalibrationKey": true,
    "isGraphKey": false,
    "specialityKeyValue": null,
    "calKeyEnumMember": "ACDB_CAL_KEY_STREAM_TYPE",
    "graphKeyEnumMember": null,
    "values": [
      {
        "name": "DEFAULT",
        "valueId": 0,
        "enumMember": "ACDB_STREAM_TYPE_DEFAULT",
        "description": "Default stream",
        "specialValue": null
      },
      {
        "name": "LOW_LATENCY",
        "valueId": 1,
        "enumMember": "ACDB_STREAM_TYPE_LOW_LATENCY",
        "description": null,
        "specialValue": null
      }
    ]
  }
]
```

---

### 4.3 `definitions/tags.json`

Sorted by `name` ASC. `keys` contains key `name` strings (references into `keys.json`).

```json
[
  {
    "name": "STREAM_PLAYBACK",
    "tagId": 8192,
    "description": "Playback stream tag",
    "isVoice": false,
    "cHeaderEnumName": "ACDB_TAG_STREAM_PLAYBACK",
    "cHeaderEnumValue": "0x00002000",
    "keys": ["StreamType", "DeviceType"]
  }
]
```

---

### 4.4 `definitions/spf-modules.json`

Sorted by `name` ASC. Parameters sorted by `paramId` ASC. Port groups sorted by `name` ASC; ports within a group by `portId` ASC.

```json
[
  {
    "name": "PCM_DECODER",
    "moduleDefinitionId": 131074,
    "displayName": "PCM Decoder",
    "description": "Decodes raw PCM frames",
    "groupName": "Decode",
    "stackSize": 4096,
    "isLoadedAtBootup": false,
    "processor": "ADSP",
    "containerTypes": ["WCD_RD_MACRO"],
    "dataPortGroups": [
      {
        "name": "InputGroup",
        "maxPorts": 1,
        "direction": "INPUT",
        "ports": [
          { "portId": 2, "name": "pcm_in", "direction": "INPUT" }
        ]
      }
    ],
    "staticControlPorts": [
      { "portId": 1, "direction": "PEER_SOURCE", "intentId": 0 }
    ],
    "dynamicIntents": [
      { "intentId": 100, "direction": "PEER_SOURCE", "name": "PCM_IN" }
    ],
    "attributes": [
      { "attributeId": 1, "value": "BYTE_DATA_FORMAT" }
    ],
    "parameters": [
      {
        "name": "PARAM_ID_PCM_OUTPUT_FORMAT_CFG",
        "paramId": 134217729,
        "description": "PCM output format",
        "maxSize": 64,
        "pidType": "SET_PARAM",
        "isPersistent": true,
        "isReadOnly": false,
        "elementsStructure": "{\"version\":1,\"fields\":[{\"name\":\"fmt\",\"type\":\"uint32\"},{\"name\":\"num_channels\",\"type\":\"uint16\"}]}"
      }
    ],
    "metaData": {
      "isSink": false,
      "isSource": true,
      "isPloEnabled": false
    }
  }
]
```

---

### 4.5 `definitions/vcpm-modules.json`

```json
[
  {
    "name": "VCPM_CLOCK_VOTE",
    "moduleDefinitionId": 196609,
    "attributes": [
      { "attributeId": 5, "value": "CLOCK_VOTE" }
    ],
    "parameters": [
      {
        "name": "PARAM_ID_VCPM_CLOCK_VOTE_VALUE",
        "paramId": 196610,
        "maxSize": 8,
        "isPersistent": false,
        "elementsStructure": "{\"version\":1,\"fields\":[{\"name\":\"clock_hz\",\"type\":\"uint64\"}]}"
      }
    ]
  }
]
```

---

### 4.6 `definitions/driver-modules.json`

```json
[
  {
    "name": "WCD_CODEC_DMA_RX",
    "moduleDefinitionId": 262145,
    "parameters": [
      {
        "name": "PARAM_ID_WCD_DMA_CLK_CFG",
        "paramId": 262146,
        "maxSize": 16,
        "isPersistent": true,
        "elementsStructure": "{\"version\":1,\"fields\":[{\"name\":\"clk_src\",\"type\":\"uint32\"},{\"name\":\"clk_freq\",\"type\":\"uint32\"}]}"
      }
    ]
  }
]
```

---

### 4.7 `containers.json`

Sorted by `containerId` ASC. `containerType` references the container type name from AWSP definitions.

```json
[
  {
    "containerId": 1,
    "containerType": "WCD_RD_MACRO",
    "properties": [
      { "propertyId": 3, "value": "0x01" }
    ]
  },
  {
    "containerId": 2,
    "containerType": "APM_GENERIC",
    "properties": []
  }
]
```

---

### 4.8 `subsystems.json`

Flat list sorted by `name` ASC. `parent` is `null` for root subsystems. `filteredKeys` contains key `name` strings.

```json
[
  {
    "name": "Audio",
    "subsystemId": 1,
    "parent": null,
    "filteredKeys": []
  },
  {
    "name": "Audio.Playback",
    "subsystemId": 2,
    "parent": "Audio",
    "filteredKeys": ["StreamType"]
  },
  {
    "name": "Audio.Capture",
    "subsystemId": 3,
    "parent": "Audio",
    "filteredKeys": []
  }
]
```

---

### 4.9 `drivers.json`

Sorted by `definition` ASC. Calibration bins sorted by key-vector join string ASC. Parameters within a bin sorted by `paramId` ASC.

```json
[
  {
    "definition": "WCD_CODEC_DMA_RX",
    "calibration": [
      {
        "keys": [
          { "key": "StreamType", "value": "DEFAULT" }
        ],
        "parameters": [
          {
            "name": "PARAM_ID_WCD_DMA_CLK_CFG",
            "paramId": 262146,
            "payload": {
              "clk_src": 1,
              "clk_freq": 48000
            }
          }
        ]
      }
    ]
  }
]
```

An empty `keys: []` array means the default (no-key) calibration bin.

---

### 4.10 `module-manager.json`

Sorted by `moduleDefinition` ASC. `moduleDefinition` is the SPF module definition name.

```json
[
  {
    "moduleDefinition": "PCM_DECODER",
    "moduleType": 4,
    "interfaceType": 2,
    "interfaceVersion": 65536,
    "fileName": "capi_pcm_dec.so",
    "tag": "CAPI_V2"
  }
]
```

---

### 4.11 `subgraphs/<sg-name>/subgraph.json`

`modules` ordered by `topologicalRank` ASC then `key` ASC. Intra-SG only (links where `sourceSubgraphSystemId === destSubgraphSystemId`). SGKV bins sorted by key-vector join string. VCPM instances sorted by `definition` ASC.

```json
{
  "name": "SG_PLAYBACK",
  "subgraphId": 1024,
  "isExported": false,
  "modules": [
    {
      "key": "PCM_DECODER_1",
      "alias": "pcm_dec_main",
      "instanceId": 8193,
      "definition": "PCM_DECODER",
      "container": 1,
      "topologicalRank": 1,
      "properties": [
        { "propertyId": 7, "value": "0x00" }
      ],
      "inputPorts": [
        { "portId": 2, "name": "pcm_in" }
      ],
      "outputPorts": [],
      "controlPorts": [
        { "portId": 1, "direction": "PEER_SOURCE" }
      ]
    },
    {
      "key": "PCM_ENCODER_1",
      "alias": "pcm_enc_main",
      "instanceId": 8194,
      "definition": "PCM_ENCODER",
      "container": 1,
      "topologicalRank": 2,
      "properties": [],
      "inputPorts": [
        { "portId": 2, "name": "pcm_in" }
      ],
      "outputPorts": [
        { "portId": 1, "name": "pcm_out" }
      ],
      "controlPorts": []
    }
  ],
  "dataLinks": [
    {
      "source": { "module": "PCM_DECODER_1", "port": 2 },
      "destination": { "module": "PCM_ENCODER_1", "port": 2 },
      "linkType": "DATA",
      "isEc": null
    }
  ],
  "controlLinks": [
    {
      "peerNodeA": { "module": "PCM_DECODER_1", "port": 1 },
      "peerNodeB": { "module": "PCM_ENCODER_1", "port": 1 },
      "heapId": 0
    }
  ],
  "sgkv": [
    {
      "keys": [
        { "key": "StreamType", "value": "LOW_LATENCY" }
      ]
    }
  ],
  "vcpmInstances": [
    {
      "definition": "VCPM_CLOCK_VOTE",
      "calibration": [
        {
          "keys": [
            { "key": "StreamType", "value": "DEFAULT" }
          ],
          "parameters": [
            {
              "name": "PARAM_ID_VCPM_CLOCK_VOTE_VALUE",
              "paramId": 196610,
              "payload": {
                "clock_hz": 96000000
              }
            }
          ]
        }
      ]
    }
  ]
}
```

Note: `container` is the `ContainerRow.containerId` integer (supplementary natural ID, not systemId).

---

### 4.12 `subgraphs/<sg-name>/modules/<module-key>.json`

CKV bins sorted by key-vector join ASC. TKV entries sorted by `tag` ASC then key-vector join ASC. Parameters within a bin sorted by `paramId` ASC.

```json
{
  "key": "PCM_DECODER_1",
  "ckv": [
    {
      "keys": [
        { "key": "StreamType", "value": "DEFAULT" }
      ],
      "parameters": [
        {
          "name": "PARAM_ID_PCM_OUTPUT_FORMAT_CFG",
          "paramId": 134217729,
          "payload": {
            "fmt": 1,
            "num_channels": 2
          }
        }
      ]
    },
    {
      "keys": [
        { "key": "StreamType", "value": "LOW_LATENCY" }
      ],
      "parameters": [
        {
          "name": "PARAM_ID_PCM_OUTPUT_FORMAT_CFG",
          "paramId": 134217729,
          "payload": {
            "fmt": 2,
            "num_channels": 4
          }
        }
      ]
    }
  ],
  "tkv": [
    {
      "tag": "STREAM_PLAYBACK",
      "keys": [
        { "key": "StreamType", "value": "DEFAULT" }
      ],
      "parameters": [
        {
          "name": "PARAM_ID_PCM_OUTPUT_FORMAT_CFG",
          "paramId": 134217729,
          "payload": {
            "fmt": 1,
            "num_channels": 2
          }
        }
      ]
    }
  ]
}
```

---

### 4.13 `usecases/<uc-alias>.json`

`subgraphs` is an ordered array of subgraph names. Cross-SG links are rows where `DataLinkRow.sourceSubgraphSystemId !== DataLinkRow.destSubgraphSystemId`.

```json
{
  "alias": "UC_PLAYBACK_48K",
  "aliasId": 32768,
  "type": "PLAYBACK",
  "gkv": [
    {
      "keys": [
        { "key": "StreamType", "value": "DEFAULT" },
        { "key": "DeviceType", "value": "SPEAKER" }
      ]
    }
  ],
  "subgraphs": ["SG_PLAYBACK", "SG_PCM_OUTPUT"],
  "subgraphPairs": [
    { "source": "SG_PLAYBACK", "destination": "SG_PCM_OUTPUT" }
  ],
  "crossSgDataLinks": [
    {
      "source": { "subgraph": "SG_PLAYBACK", "module": "PCM_ENCODER_1", "port": 1 },
      "destination": { "subgraph": "SG_PCM_OUTPUT", "module": "I2S_SINK_1", "port": 2 },
      "linkType": "DATA",
      "isEc": null
    }
  ],
  "crossSgControlLinks": [
    {
      "peerNodeA": { "subgraph": "SG_PLAYBACK", "module": "PCM_ENCODER_1", "port": 1 },
      "peerNodeB": { "subgraph": "SG_PCM_OUTPUT", "module": "I2S_SINK_1", "port": 1 },
      "heapId": 0
    }
  ]
}
```

---

## 5. Identifier Strategy

### 5.1 Stable Primary Keys

No file uses a DB `systemId` as a primary key. All cross-references use semantic names:

| Entity | HRF identifier | DB source column |
|--------|----------------|-----------------|
| Key definition | `name` | `arc_keys.name` |
| Value definition | `name` (within key) | `arc_values.name` |
| Tag | `name` | `tag_definitions.name` |
| SPF module definition | `name` | `spf_module_definitions.name` |
| VCPM module definition | `name` | `vcpm_module_definitions.name` |
| Driver module definition | `name` | `driver_module_definitions.name` |
| Subgraph | `name` | `subgraphs.name` |
| Container | `containerId` (natural ID) | `containers.container_id` |
| Usecase | `alias` | `use_cases.alias` |
| SPF module instance | `<definitionName>_<rank>` | computed (see §5.3) |

### 5.2 Supplementary IDs

The following integer IDs appear as informational fields and are **ignored on import** for entity lookup:

`subgraphId`, `instanceId`, `aliasId`, `keyId`, `valueId`, `tagId`, `moduleDefinitionId`

`paramId` is the exception — it is preserved and used during calibration decode/encode as the parameter lookup key.

### 5.3 Module Stable Key Computation

The stable key `<definitionName>_<N>` is computed during export:

1. Load all `SpfModuleRow` instances for the subgraph.
2. Build directed graph: nodes = module instances; edges = intra-SG data links (`sourceNodeSystemId → destinationNodeSystemId`).
3. Compute topological sort (Kahn's algorithm). Use `instanceId` ASC as the tie-breaker among nodes with equal in-degree.
4. N = 1-based position in sorted order (upstream sources = rank 1).
5. Group instances by `definitionName`. If only one instance of a definition, key is `<name>_1`. If multiple, each gets its own rank: `PCM_DECODER_1`, `PCM_DECODER_2`.

On import, the rank is used only to order insertion and to match the supplementary `instanceId`. Entity lookup during link wiring uses the full key string as a local reference.

---

## 6. Calibration Encoding

### 6.1 Overview

Calibration payloads are stored as raw `Uint8Array` blobs in `ckv_parameter_payload.payload`, `tkv_parameter_payload.payload`, `dkv_parameter_payload.payload`, and `vcpm_parameter_payload.payload`.

The decode schema is `spf_module_parameter_definitions.elementsStructure` — a JSON string describing the binary layout. If `elementsStructure` is absent for a parameter with a non-null payload, the exporter throws `HrfMissingElementsStructureError` (FR-06).

### 6.2 HrfDecodeCache

Built in Export Phase 1 from all parameter definition rows:

```
HrfDecodeCache {
  // keyed by parameterSystemId
  schemas: Map<number, ParsedElementsStructure>
  decode(parameterSystemId, payload: Uint8Array): unknown
  encode(parameterSystemId, value: unknown): Uint8Array
}
```

One cache instance covers SPF, VCPM, and driver parameters.

### 6.3 Parameter Value Types in JSON

| `elementsStructure` type | JSON representation |
|--------------------------|---------------------|
| `uint8`, `uint16`, `uint32` | JSON number |
| `uint64` | JSON number (string `"b64:<hex>"` if > 2^53) |
| `int8`, `int16`, `int32` | JSON number (signed) |
| `float` | JSON number |
| `bool` | JSON `true` / `false` |
| `enum` (uint32-backed) | JSON number |
| `uint8[]` (byte array) | Base64 string prefixed `"b64:"` |
| nested struct | JSON object |
| array of struct | JSON array of objects |

### 6.4 Encode Direction (Import)

The importer reads the `payload` JSON object and re-serializes to `Uint8Array` using the same `elementsStructure`. The encode path is the strict inverse of decode. The importer builds `HrfDecodeCache` from the definitions files being imported (same as export Phase 1).

---

## 7. Link Representation

### 7.1 Intra-SG vs Cross-SG

| Condition | Placement |
|-----------|-----------|
| `DataLinkRow.sourceSubgraphSystemId === DataLinkRow.destSubgraphSystemId` | `subgraphs/<sg>/subgraph.json` → `dataLinks` |
| `DataLinkRow.sourceSubgraphSystemId !== DataLinkRow.destSubgraphSystemId` | `usecases/<alias>.json` → `crossSgDataLinks` |
| Control links — same SG | `subgraphs/<sg>/subgraph.json` → `controlLinks` |
| Control links — different SGs | `usecases/<alias>.json` → `crossSgControlLinks` |

### 7.2 Port Reference Syntax

Intra-SG (within `subgraph.json`):
```json
{ "module": "PCM_DECODER_1", "port": 2 }
```

Cross-SG (within `usecase.json`):
```json
{ "subgraph": "SG_PLAYBACK", "module": "PCM_ENCODER_1", "port": 1 }
```

`module` is the stable key (`<definitionName>_<rank>`). `port` is the integer `portId` from `data_ports` or `control_ports`. If the port has a `name` from the definition, it is included as a supplementary `portName` field for readability but is not used on import.

### 7.3 Data vs Control Link Fields

Data link: `{ source, destination, linkType, isEc }`  
Control link: `{ peerNodeA, peerNodeB, heapId }` (no direction — control links are bidirectional)

`linkType` is the `DataLinkRow.linkType` enum value. `isEc` is `DataLinkRow.isEc` (boolean or null).

---

## 8. Export Service Design

### 8.1 Architecture — Option 3: Bulk Load + Lazy Calibration Decode

Definitions are loaded once as a decode cache. Structure (no blobs) is loaded next. Calibration blobs are loaded and decoded per-subgraph to keep memory bounded.

```
Phase 1 — Build HrfDecodeCache
  Load SpfModuleParameterDefinitionRow, VcpmModuleParameterDefinitionRow,
  DriverModuleParameterDefinitionRow (all with elementsStructure).
  Build HrfDecodeCache: parameterSystemId → ParsedElementsStructure.

Phase 2 — Load definitions + structure, write top-level files
  - Load and write: metadata.json, definitions/keys.json, definitions/tags.json,
    definitions/spf-modules.json, definitions/vcpm-modules.json,
    definitions/driver-modules.json, containers.json, subsystems.json,
    module-manager.json
  - Load all SubgraphRow, SpfModuleRow, NodeRow, DataPortRow, ControlPortRow,
    SpfModulePropertiesDataRow (no calibration blobs)
  - Load all SgkvRow + SgkvValuesRow
  - Load all VcpmInstanceRow (no payloads yet)
  - Load all DataLinkRow and ControlLinkRow

Phase 3 — Write subgraphs (lazy calibration per subgraph)
  For each subgraph (sorted by name):
    a. Compute module stable keys (topological sort of intra-SG links)
    b. Load VcpmCkvRow + VcpmCkvValuesRow + VcpmParameterPayloadRow → decode → embed in subgraph.json
    c. Write subgraphs/<name>/subgraph.json
    d. For each module (sorted by stable key):
       - Load CkvRow + CkvValuesRow + CkvParameterPayloadRow → decode
       - Load ModuleTagIdMapRow + TkvRow + TkvValuesRow + TkvParameterPayloadRow → decode
       - Write subgraphs/<name>/modules/<key>.json

Phase 4 — Write drivers and usecases
  - Load DriverModuleRow + DkvRow + DkvValuesRow + DkvParameterPayloadRow → decode → write drivers.json
  - For each UseCaseRow (sorted by alias):
    - Load use_case_subgraphs, UseCaseSubgraphPairRow
    - Load cross-SG DataLinkRow and ControlLinkRow for this usecase
    - Write usecases/<alias>.json

Phase 5 — Assemble and return ZIP
  ZipBuilder.build(fileMap) → Uint8Array ZIP with mtime=0 for determinism
```

### 8.2 Key Classes

```
packages/core/src/application/file-operations/hrf/export/

HrfExportOrchestrator
  orchestrate(fileSystemId: number): Promise<Uint8Array>

HrfDecodeCache
  build(params: ParameterDefinitionRow[]): void
  decode(parameterSystemId: number, payload: Uint8Array): unknown
  encode(parameterSystemId: number, value: unknown): Uint8Array
  // throws HrfMissingElementsStructureError if schema absent

HrfFileSerializer
  // All methods return JSON.stringify with stable key order + 2-space indent
  serializeMetadata(file: ArcDbFileRow): string
  serializeKeys(keys: KeyDefinitionRow[], values: ValueDefinitionRow[]): string
  serializeTags(tags: TagDefinitionRow[], links: TagKeyDefLinkRow[]): string
  serializeSubgraph(data: SubgraphExportData): string
  serializeModule(data: ModuleExportData): string
  serializeUsecase(data: UsecaseExportData): string
  // ... one method per file type

ZipBuilder
  add(path: string, content: string): void
  build(): Promise<Uint8Array>    // mtime=0 on all entries
```

---

## 9. Import Service Design

### 9.1 Architecture — Option 3: HrfNameResolver + Reuse Inserters

`HrfNameResolver` mirrors `ForeignKeyMapper` (upload-file) in reverse: name → systemId. Built from definitions files first, then extended as structure is inserted.

```
Phase 0 — Unzip and validate
  Verify required top-level files exist (metadata.json, definitions/*, etc.)
  Collect missing-file errors; abort if any required file missing.

Phase 1 — Parse definitions, build HrfNameResolver + HrfDecodeCache
  Parse definitions/keys.json → insert via insertKeyDefinitions
    → populate resolver: keyName → systemId; valueName → valueDefSystemId
  Parse definitions/tags.json → insert → populate resolver
  Parse definitions/spf-modules.json → insert → populate resolver
    → build HrfDecodeCache from parameter definitions
  Parse definitions/vcpm-modules.json, driver-modules.json → insert → populate resolver

Phase 2 — Parse and insert structure
  Parse metadata.json → update ArcDbFile header
  Parse containers.json → resolve containerType name → systemId → insert
  Parse subsystems.json → topological sort by parent → insert
  Parse module-manager.json → resolve module def names → insert
  For each subgraph/ directory (sorted by name):
    Parse subgraph.json → resolve definition names, container naturalIds
    Insert SubgraphRow → record systemId in resolver (subgraphName → systemId)
    Insert SpfModuleRow (ordered by topologicalRank) → record module instance systemIds
    Insert NodeRow, DataPortRow, ControlPortRow
    Insert SgkvRow + SgkvValuesRow
    Insert VcpmInstanceRow (structure only)
    Insert intra-SG DataLinkRow + ControlLinkRow

Phase 3 — Insert calibration
  For each subgraph directory:
    For each modules/<key>.json:
      Parse → resolve module instance systemId via resolver
      Encode CKV payload via HrfDecodeCache.encode()
      Insert CkvRow + CkvValuesRow + CkvParameterPayloadRow
      Insert ModuleTagIdMapRow + TkvRow + TkvValuesRow + TkvParameterPayloadRow
    Parse VCPM calibration from subgraph.json → encode → insert VcpmCkvRow + payloads
  Parse drivers.json → encode DKV → insert DriverModuleRow + DkvRow + payloads

Phase 4 — Insert usecases
  For each usecases/<alias>.json:
    Resolve subgraph names → systemIds
    Insert UseCaseRow, use_case_subgraphs, UseCaseSubgraphPairRow
    Insert cross-SG DataLinkRow + ControlLinkRow
```

### 9.2 HrfNameResolver

```typescript
// packages/core/src/application/file-operations/hrf/import/hrf-name-resolver.ts

class HrfNameResolver {
  resolveKey(name: string): number | undefined            // keyDefinitionSystemId
  resolveValue(keyName: string, valueName: string): number | undefined
  resolveTag(name: string): number | undefined
  resolveSpfModuleDef(name: string): number | undefined
  resolveVcpmModuleDef(name: string): number | undefined
  resolveDriverModuleDef(name: string): number | undefined
  resolveSpfParam(moduleDefName: string, paramName: string): number | undefined
  resolveContainerType(name: string): number | undefined
  resolveContainer(containerId: number): number | undefined  // naturalId → systemId
  resolveSubgraph(name: string): number | undefined
  resolveSpfModuleInstance(sgName: string, moduleKey: string): number | undefined
}
```

Populated incrementally after each batch insert. Unresolvable names are recorded as `HrfImportIssue` entries and the affected entity is skipped.

### 9.3 Continue-on-Error Flow

```typescript
interface HrfImportIssue {
  file: string;     // e.g. "subgraphs/SG_PLAYBACK/modules/PCM_DECODER_1.json"
  field: string;    // e.g. "ckv[0].keys[0].value"
  message: string;  // e.g. "Unknown value 'FOO' for key 'StreamType'"
}
```

Structural errors (unknown subgraph name) cascade: all links referencing that subgraph are also skipped. The response returns `{ projectId, openStatus, issues: HrfImportIssue[] }`.

### 9.4 Reuse of Existing Inserters

All existing `BulkImportRepository` methods are reused unchanged:

| Import phase | Existing inserter |
|-------------|------------------|
| Definitions | `insertKeyDefinitions`, `insertTagDefinitions`, `insertSpfModuleDefinitions`, `insertVcpmModuleDefinitions`, `insertDriverModuleDefinitions` |
| Structure | `insertSubgraphs`, `insertContainers`, `insertSpfModules`, `insertSubsystems`, `insertModuleManagerData` |
| Links | `insertDataLinks`, `insertControlLinks` |
| Calibration | CKV/TKV/DKV inserted as part of module rows (same path as upload-file) |
| Usecases | `insertUseCases` |

---

## 10. Determinism Rules

All `JSON.stringify` calls use 2-space indentation with alphabetically-sorted object keys (via a custom replacer). Every array uses the sort order below:

| Array | Sort key(s) |
|-------|-------------|
| `definitions/keys.json` root | `name` ASC, `keyId` ASC |
| `values` within a key | `valueId` ASC |
| `definitions/tags.json` root | `name` ASC |
| `definitions/spf-modules.json` root | `name` ASC |
| Parameters within a module definition | `paramId` ASC |
| Port groups | `name` ASC; ports within group by `portId` ASC |
| Attributes | `attributeId` ASC |
| `containers.json` | `containerId` ASC |
| `subsystems.json` | `name` ASC |
| `drivers.json` | `definition` ASC |
| Calibration bins (CKV/TKV/DKV/VCPM) | key-vector join string ASC: `"key1Name:val1Name\|key2Name:val2Name"` (keys in `keyId` ASC order) |
| Parameters within a calibration bin | `paramId` ASC |
| `module-manager.json` | `moduleDefinition` ASC |
| Modules in `subgraph.json` | `topologicalRank` ASC, then `key` ASC |
| Intra-SG `dataLinks` | `source.module` ASC, `source.port` ASC |
| Intra-SG `controlLinks` | canonical pair: `min(peerA.module,peerB.module)` ASC |
| SGKV bins | key-vector join ASC |
| VCPM instances | `definition` ASC |
| VCPM calibration bins | key-vector join ASC |
| Module `ckv` | key-vector join ASC |
| Module `tkv` | `tag` ASC, key-vector join ASC |
| Subgraph directories | subgraph `name` ASC |
| Module files within a subgraph | `key` ASC |
| Usecase files | `alias` ASC |
| `subgraphPairs` | `source` ASC, `destination` ASC |
| `crossSgDataLinks` | `source.subgraph` ASC, `source.module` ASC, `source.port` ASC |

ZIP entries are added in a fixed order (metadata → definitions → containers → subsystems → drivers → module-manager → subgraphs → usecases) with `mtime = 0` on all entries.

---

## 11. Verification

### 11.1 Export Smoke Test

1. Upload a known ACDB + AWSP pair.
2. `GET /projects/:id/export/hrf` → unzip response.
3. Verify file tree structure matches §3.
4. Check `metadata.json` ACDB version fields match the uploaded header.
5. Count keys in `definitions/keys.json` against `SELECT COUNT(*) FROM arc_keys WHERE file_system_id = ?`.
6. Pick one subgraph: verify `subgraph.json` module count matches `SELECT COUNT(*) FROM spf_modules WHERE subgraph_system_id = ?`.
7. Pick one module with CKV: verify `modules/<key>.json` bin count matches `SELECT COUNT(*) FROM ckv WHERE spf_module_system_id = ?`.

### 11.2 Round-Trip Test

1. Export project P → `hrf_v1.zip`.
2. Create project Q. Import `hrf_v1.zip` via `POST /projects/import/hrf`.
3. Export project Q → `hrf_v2.zip`.
4. Unzip both. Diff every `*.json` file. Zero differences expected.

### 11.3 Determinism Test

1. Export the same project twice without any DB changes: `export_a.zip`, `export_b.zip`.
2. Assert the two ZIPs are byte-for-byte identical (requires `mtime = 0` in ZipBuilder).

### 11.4 Continue-on-Error Test

1. Corrupt one `modules/<key>.json` — use an unknown value name in a CKV `keys` array.
2. Import the archive.
3. Assert the response contains exactly one issue pointing to the corrupt file.
4. Assert all other data (other modules, subgraphs, usecases, definitions) was inserted correctly.

---

## 12. New File Locations

```
packages/core/src/application/file-operations/hrf/
  export/
    hrf-export-orchestrator.ts
    hrf-decode-cache.ts
    hrf-file-serializer.ts
    hrf-zip-builder.ts
  import/
    hrf-import-orchestrator.ts
    hrf-name-resolver.ts
    hrf-issue-collector.ts
    hrf-payload-encoder.ts
  shared/
    hrf-types.ts               (HrfImportIssue, export data interfaces)
    hrf-topological-sort.ts    (module stable key computation)

packages/api/src/presentation/rest/modules/project/
  (extend existing project.controller.ts with two new routes)
```

### Critical Existing Files to Reference During Implementation

| File | Why |
|------|-----|
| `upload-file/services/upload-file-orchestrator.ts` | Phase structure + continue-on-error pattern |
| `upload-file/services/foreign-key-mapper.ts` | HrfNameResolver mirrors this |
| `download-file/services/awsp-file-serializer.ts` | Serializer pattern to follow |
| `infrastructure/persistence/.../repositories/bulk-import/typeorm-bulk-import.repository.ts` | Inserter methods to call |
| `entity-schema/usecase-data/module/spf-module-calibration-data.schema.ts` | CKV row structure |
| `entity-schema/usecase-data/subgraph/subgraph-vcpm-data.ts` | VCPM row structure |
| `entity-schema/driver-module-data/driver-module.ts` | DKV row structure |
| `entity-schema/usecase-data/Links/data-link.ts` | Link classification (intra vs cross SG) |
