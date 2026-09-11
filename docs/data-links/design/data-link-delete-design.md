# Data-Link Delete API Design

**Date:** 2026-09-10  
**Status:** Approved design; implementation pending  
**Endpoint:** `DELETE /arc-api/v1/projects/{projectId}/data-links/{dataLinkSystemId}`

## 1. Context

The data-link controller and command are already scaffolded, but
`DeleteDataLinkHandler` is not implemented. The existing module-delete workflow
already provides the required aggregate deletion behavior through
`DataLinkDeletionService` and `DataLinkRepository.deleteAggregate()`.

The endpoint currently documents a `200` response containing the deleted link
snapshot. Preserving that contract requires an effective, session-overlay-aware
lookup before staging deletion. No schema or deletion-mutation change is
required.

## 2. Requirements

### 2.1 Functional Requirements

| ID | Requirement |
|----|-------------|
| FR-DLD-01 | Accept a decimal `dataLinkSystemId`; malformed values return `400`. |
| FR-DLD-02 | Require an authenticated active `DESIGNER` session for the project. No active session or another mode returns `403`. |
| FR-DLD-03 | Resolve the canonical data link from the effective session overlay, scoped to the active session's file. A nonexistent or already session-deleted link returns `404` with a `DataLink` entity-not-found issue. |
| FR-DLD-04 | On success, atomically stage deletion of the canonical data link and every resolved subsystem-data-link segment belonging to it, using the existing aggregate deletion behavior. |
| FR-DLD-05 | Return `200` with the pre-deletion `DataLinkResponseDto` snapshot inside the standard `ApiResult` envelope; internal session group IDs are not exposed. |
| FR-DLD-06 | Affect only the link aggregate in the active project/session. Modules, ports, subgraphs, containers, control links, and unrelated unresolved subsystem segments must remain unaffected. |

### 2.2 Non-Functional Requirements

| ID | Requirement |
|----|-------------|
| NFR-DLD-01 | Follow the existing command/UoW transaction and structured logging conventions; failures roll back staged actions. |

### 2.3 Invariants

**I1 — Session scope:** All reads and writes are scoped to the active session's
file and session overlay.

**I2 — Aggregate deletion:** Deleting a canonical data link deletes its
canonical row and all currently resolved subsystem-data-link segments assigned
to it. Unresolved segments are not implicitly deleted by
`deleteAggregate()`.

**I3 — Transactional operation:** The lookup and deletion are part of one
handler-owned transaction. Any failure leaves no staged deletion after
rollback.

### 2.4 Out of Scope

- Control-link deletion.
- Direct deletion of an unresolved subsystem-data-link segment.
- `segmentOnly` deletion behavior.
- Undo/recreate API work.
- Database schema or migration changes.

## 3. Existing Patterns And Constraints

The implementation must preserve the repository architecture:

- The API package owns NestJS controllers, DTOs, guards, and HTTP mapping.
- The core package owns commands, handlers, domain exceptions, repository
  ports, and deletion orchestration. It must not import NestJS, TypeORM, or
  Node APIs.
- The persistence package implements the core repository port with TypeORM and
  the existing `LinkOverlayFetcher`.
- `CommandBus` enforces command session policy and stamps `WriteContext`.
- The command handler owns `startTransaction()`, `commit()`, and `rollback()`.

The SPF-module delete endpoint is the reference API pattern: it uses
`SessionGuard`, `@ArcSession()`, a session-required Designer-only command, a
transactional handler, structured not-found issues, and a response that hides
the internal edit-action group ID.

## 4. Approaches Considered

### 4.1 Dedicated Lookup Plus Existing Aggregate Deletion (Selected)

Add a session-overlay-aware `findBySystemId()` method to the core
`DataLinkRepository` port and implement it in the TypeORM adapter with
`LinkOverlayFetcher`. The handler reads and maps the effective link, then calls
the existing `deleteAggregate()` mutation.

This keeps query and mutation responsibilities explicit, preserves all current
callers of `deleteAggregate()`, and is the smallest change that supports the
published snapshot response and precise `404` behavior.

### 4.2 Make `deleteAggregate()` Return The Snapshot

Change `deleteAggregate()` to load and return the pre-delete link while staging
the deletion. This reduces the handler to one repository call but couples a
reusable mutation to response-oriented querying and changes the existing port
contract for module deletion callers and tests.

### 4.3 Use An Existing Query Service

Read the link through an existing query service before invoking the write
repository. This avoids a port change but does not provide the required
session-overlay semantics. The available validation query implementation is
also stubbed, so it cannot reliably represent session-created, updated, or
deleted links.

## 5. Architecture

### 5.1 API Layer

Update `DataLinkController.deleteDataLink` to:

1. Keep JWT authentication and the existing route.
2. Apply `SessionGuard` to require an active project session.
3. Parse `dataLinkSystemId` with `ParseIntPipe`.
4. Receive the active session with `@ArcSession()`.
5. Execute `DeleteDataLinkCommand` with the session.
6. Return the handler's snapshot through the standard `ApiResult` envelope.

The endpoint remains `200 OK` with `DataLinkResponseDto`. The controller
documentation will describe that the canonical link and its resolved aggregate
segments are removed.

### 5.2 Core Command And Policy

`DeleteDataLinkCommand` will declare:

- `requiresSession = true`.
- `allowedModes = [SESSION_MODE.Designer]`.
- The existing numeric `dataLinkSystemId` payload.

`CommandBus` will reject a missing session or disallowed mode before handler
execution and will stamp the UoW with the active session and generated group
ID.

### 5.3 Core Handler

`DeleteDataLinkHandler` will:

1. Start a transaction.
2. Read `fileSystemId` and `sessionId` from `uow.getWriteContext()` and the
   repository's session context.
3. Call `uow.getDataLinkRepository().findBySystemId(...)`.
4. Throw `ResourceNotFoundException` with
   `IssueFactory.notFound(ISSUE_ENTITY_TYPE.DataLink, id)` when no effective
   link exists.
5. Map the loaded link to the existing `DataLinkDto` response shape before
   deletion.
6. Call the existing `deleteAggregate(dataLinkSystemId, fileSystemId)`.
7. Commit and return the snapshot.
8. Roll back when any step fails, then rethrow the original error.

The optional core `Logger` will receive success and failure events using the
structured logging convention. Logged IDs use `BinaryUtils.toHexString()` and
are paired with a human-readable description where available.

### 5.4 Persistence Port And Adapter

Add one method to `DataLinkRepository`:

```typescript
findBySystemId(
  dataLinkSystemId: number,
  fileSystemId: number,
): Promise<DataLink | null>;
```

`TypeOrmDataLinkRepository.findBySystemId()` will use the existing
`LinkOverlayFetcher.loadDataLinkRows()` with:

- the supplied `fileSystemId`;
- the active session ID from `uow.getWriteContext()`; and
- `{systemId: dataLinkSystemId}` as the filter.

The first effective row is converted with the repository's existing
`baseToDataLink()` mapper. The method returns `null` for an absent row,
including a row hidden by a session delete. It must not query outside the
active file.

`deleteAggregate()` remains unchanged. It continues to use
`PendingChangeWriter` to stage a delete for the canonical data link and every
resolved subsystem segment, without deleting unresolved segments.

## 6. Data Flow

```text
HTTP DELETE
  -> JWT guard
  -> SessionGuard resolves active project session
  -> ParseIntPipe validates dataLinkSystemId
  -> CommandBus enforces DESIGNER-only policy
  -> CommandBus stamps WriteContext
  -> DeleteDataLinkHandler starts transaction
  -> findBySystemId(fileSystemId, session overlay)
  -> map pre-delete DataLink snapshot
  -> deleteAggregate(dataLinkSystemId, fileSystemId)
  -> commit
  -> { data: DataLinkResponseDto }
```

The lookup must precede deletion so the response reflects the effective
pre-delete state. The mutation stages edit actions; it does not physically
delete base rows during the request.

The existing `mapDataLink()` mapper will derive `isInterUsecase` from
`linkType === LINK_TYPE.InterUsecase` rather than always returning `false`.
This is required for an accurate snapshot when deleting an inter-usecase link.

## 7. Error Handling

| Condition | Result |
|-----------|--------|
| Missing JWT authentication | Existing authentication failure response. |
| No active project session | `403 SESSION_NOT_OPEN` from `SessionGuard`. |
| Active session is not `DESIGNER` | `403` from `CommandBus` session-mode enforcement. |
| Malformed `dataLinkSystemId` | `400` from `ParseIntPipe`. |
| Link absent, already deleted in this session, or outside the session file | `404 RESOURCE_NOT_FOUND` with an `ENTITY_NOT_FOUND` issue for `DataLink`. |
| Unexpected repository or transaction failure | Roll back active transaction and use the existing global exception mapping. |

The endpoint does not reveal whether a supplied ID exists in another project;
cross-file lookups return the same not-found result.

## 8. Testing Strategy

### 8.1 Core Unit Tests

Add handler coverage for:

- Successful lookup, snapshot mapping, aggregate deletion, commit, and return
  value.
- Lookup miss producing a `DataLink` entity-not-found issue.
- Correct use of the active file system ID.
- Repository failure causing rollback and error propagation.
- No commit after a failed lookup or deletion.

Retain existing `DataLinkDeletionService` unit tests because the endpoint
delegates aggregate behavior to the already-tested service.

### 8.2 Persistence Integration Tests

Add focused `findBySystemId()` coverage for:

- A base canonical link returned by system ID.
- A session-created or session-updated effective link being returned.
- A session-deleted link being hidden.
- A matching ID in another file returning `null`.

Existing `deleteAggregate()` tests already verify canonical and resolved
subsystem-segment edit actions and should not be duplicated for this endpoint.

### 8.3 API E2E Tests

Follow the existing module-delete fixture and session lifecycle. Cover:

- `200` response with the deleted link snapshot and no internal `groupId`.
- Canonical and resolved segment deletion actions being staged.
- Malformed ID returning `400`.
- No active session returning `403`.
- Non-Designer active session returning `403`.
- Missing or already-deleted link returning `404` with a DataLink issue.
- A link ID from another project returning `404` and leaving the other project
  unchanged.

### 8.4 API Documentation

Regenerate `docs/swagger-api.json` after controller metadata is finalized. The
documented contract remains `200` with `DataLinkResponseDto`, `404` for a
missing project-scoped link, and the existing server error response.

## 9. Expected File Changes

Implementation planning should cover these focused changes:

- `packages/api/src/presentation/rest/modules/data-link/data-link.controller.ts`
- `packages/api/tests/e2e/data-links/delete-data-link.e2e-spec.ts`
- `packages/core/src/application/usecase-designer/data-links/delete/delete-data-link.command.ts`
- `packages/core/src/application/usecase-designer/data-links/delete/delete-data-link.handler.ts`
- `packages/core/src/application/ports/persistence/repositories/data-link/data-link.repository.ts`
- `packages/core/src/application/usecase-designer/usecase/dto/component-collection-dto.ts`
- `packages/core/tests/unit/application/usecase-designer/data-links/delete/delete-data-link.handler.spec.ts`
- `packages/infrastructure/persistence/src/persistence-typeorm-sqllite/repositories/data-link/data-link.repository.ts`
- `packages/infrastructure/persistence/tests/integration/repositories/data-link/data-link.repository.integration.spec.ts`
- `docs/swagger-api.json`

No entity schema, migration, or existing aggregate-deletion mutation changes
are expected.

## 10. Alignment And Self-Review

### Requirements Coverage

- FR-DLD-01: API `ParseIntPipe` and e2e malformed-ID coverage.
- FR-DLD-02: JWT guard, `SessionGuard`, command session policy, and e2e mode
  coverage.
- FR-DLD-03: `findBySystemId()` overlay lookup, structured not-found issue,
  and persistence/API tests.
- FR-DLD-04: Existing `deleteAggregate()` reused unchanged and covered by
  existing integration tests plus endpoint e2e verification.
- FR-DLD-05: Pre-delete mapping and `ApiResult` response contract.
- FR-DLD-06: File-scoped lookup and aggregate-only mutation invariants.
- NFR-DLD-01: Handler transaction lifecycle and structured logging design.

### Architecture And Scope Review

- Core remains free of NestJS, TypeORM, and Node APIs.
- Persistence access is exposed through a core port and implemented in the
  infrastructure adapter.
- Transaction ownership remains with the handler, not the bus.
- No new implicit CRUD, undo, schema, or unresolved-segment behavior was
  introduced.
- No unresolved placeholders, TODOs, or open design questions remain.
