/*
 * Copyright (c) Qualcomm Technologies, Inc. and/or its subsidiaries.
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
import type {INestApplication} from '@nestjs/common';
import request from 'supertest';
import {dirname, join} from 'path';
import {fileURLToPath} from 'url';
import {setupE2ETest, teardownE2ETest} from '../helpers/e2e-test-setup.js';
import {DataSourceProvider} from '../../../src/infrastructure-wrapper/database/providers/data-source-provider.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type HttpServer = Parameters<typeof request>[0];

type DataLinkFixture = {
  systemId: number;
  fileSystemId: number;
  sourceNodeSystemId: number;
  destinationNodeSystemId: number;
  sourcePortSystemId: number;
  destinationPortSystemId: number;
  linkType: string;
  resolvedSegmentSystemIds: number[];
  unresolvedSegmentSystemIds: number[];
};

async function uploadProject(
  httpServer: unknown,
  authToken: string,
): Promise<string> {
  const acdbPath = join(__dirname, '../fixtures/acdb_cal.acdb');
  const awspPath = join(__dirname, '../fixtures/workspaceFileXml.awsp');
  const response = await request(httpServer as HttpServer)
    .post('/arc-api/v1/projects/offline/upload-files')
    .set('Authorization', `Bearer ${authToken}`)
    .attach('acdbFile', acdbPath)
    .attach('workspaceFile', awspPath)
    .timeout(120_000)
    .expect(201);
  return response.body.data.projectId as string;
}

async function startDesignerSession(
  httpServer: unknown,
  authToken: string,
  projectId: string,
): Promise<void> {
  await request(httpServer as HttpServer)
    .post(`/arc-api/v1/projects/${projectId}/start-session`)
    .set('Authorization', `Bearer ${authToken}`)
    .send({mode: 'DESIGNER'})
    .timeout(30_000)
    .expect(201);
}

async function endSession(
  httpServer: unknown,
  authToken: string,
  projectId: string,
): Promise<void> {
  await request(httpServer as HttpServer)
    .post(`/arc-api/v1/projects/${projectId}/end-session`)
    .set('Authorization', `Bearer ${authToken}`)
    .timeout(30_000);
}

async function getDataLinkFixture(
  app: INestApplication,
  projectId: string,
): Promise<DataLinkFixture> {
  const dataSource = await app.get(DataSourceProvider).getDataSource();
  const rows = await dataSource.query(
    `SELECT dl.system_id AS systemId,
            dl.file_system_id AS fileSystemId,
            dl.source_node_system_id AS sourceNodeSystemId,
            dl.destination_node_system_id AS destinationNodeSystemId,
            dl.source_port_system_id AS sourcePortSystemId,
            dl.destination_port_system_id AS destinationPortSystemId,
            dl.link_type AS linkType,
            COUNT(sdl.system_id) AS resolvedSegmentCount
       FROM data_links dl
       INNER JOIN files f ON f.system_id = dl.file_system_id
       LEFT JOIN subsystem_data_links sdl
         ON sdl.data_link_system_id = dl.system_id
        AND sdl.file_system_id = dl.file_system_id
      WHERE f.project_system_id = ?
      GROUP BY dl.system_id
      ORDER BY resolvedSegmentCount DESC,
               CASE WHEN dl.link_type = 'INTER_USECASE' THEN 0 ELSE 1 END,
               dl.system_id
      LIMIT 1`,
    [projectId],
  );
  if (rows.length === 0) throw new Error('Fixture has no data link');

  const row = rows[0] as Record<string, unknown>;
  const resolvedRows = await dataSource.query(
    `SELECT sdl.system_id AS systemId
       FROM subsystem_data_links sdl
      WHERE sdl.file_system_id = ?
        AND sdl.data_link_system_id = ?
      ORDER BY sdl.system_id`,
    [row.fileSystemId, row.systemId],
  );
  const unresolvedRows = await dataSource.query(
    `SELECT sdl.system_id AS systemId
       FROM subsystem_data_links sdl
      WHERE sdl.file_system_id = ?
        AND sdl.data_link_system_id IS NULL
      ORDER BY sdl.system_id`,
    [row.fileSystemId],
  );

  return {
    systemId: Number(row.systemId),
    fileSystemId: Number(row.fileSystemId),
    sourceNodeSystemId: Number(row.sourceNodeSystemId),
    destinationNodeSystemId: Number(row.destinationNodeSystemId),
    sourcePortSystemId: Number(row.sourcePortSystemId),
    destinationPortSystemId: Number(row.destinationPortSystemId),
    linkType: String(row.linkType),
    resolvedSegmentSystemIds: resolvedRows.map((segment: {systemId: number}) =>
      Number(segment.systemId),
    ),
    unresolvedSegmentSystemIds: unresolvedRows.map(
      (segment: {systemId: number}) => Number(segment.systemId),
    ),
  };
}

async function getProjectDataLinkIds(
  app: INestApplication,
  projectId: string,
): Promise<number[]> {
  const dataSource = await app.get(DataSourceProvider).getDataSource();
  const rows = await dataSource.query(
    `SELECT dl.system_id AS systemId
       FROM data_links dl
       INNER JOIN files f ON f.system_id = dl.file_system_id
      WHERE f.project_system_id = ?`,
    [projectId],
  );
  return rows.map((row: {systemId: number}) => Number(row.systemId));
}

async function getActiveEditActions(
  app: INestApplication,
  projectId: string,
): Promise<Array<Record<string, unknown>>> {
  const dataSource = await app.get(DataSourceProvider).getDataSource();
  return dataSource.query(
    `SELECT ea.target_table AS targetTable,
            ea.target_system_id AS targetSystemId,
            ea.operation AS operation
       FROM edit_actions ea
       INNER JOIN project_sessions ps ON ps.session_id = ea.session_id
       INNER JOIN files f ON f.system_id = ps.file_system_id
      WHERE f.project_system_id = ?
        AND ps.status = 'ACTIVE'
        AND ea.valid_until IS NULL
      ORDER BY ea.change_id`,
    [projectId],
  ) as Promise<Array<Record<string, unknown>>>;
}

async function forceEndTestSession(
  app: INestApplication,
  projectId: string,
): Promise<void> {
  const dataSource = await app.get(DataSourceProvider).getDataSource();
  await dataSource.query(
    `DELETE FROM edit_actions
      WHERE session_id IN (
        SELECT ps.session_id
          FROM project_sessions ps
          INNER JOIN files f ON f.system_id = ps.file_system_id
         WHERE f.project_system_id = ?
      )`,
    [projectId],
  );
  await dataSource.query(
    `UPDATE project_sessions
        SET status = 'ENDED', ended_at = CURRENT_TIMESTAMP
      WHERE status = 'ACTIVE'
        AND file_system_id IN (
          SELECT f.system_id
            FROM files f
           WHERE f.project_system_id = ?
        )`,
    [projectId],
  );
}

describe('E2E: DELETE /arc-api/v1/projects/:projectId/data-links/:dataLinkSystemId', () => {
  let app: INestApplication;
  let httpServer: unknown;
  let authToken: string;
  let projectId: string;
  let dataLink: DataLinkFixture;

  beforeAll(async () => {
    const setup = await setupE2ETest();
    app = setup.app;
    httpServer = setup.httpServer;
    authToken = setup.authToken;
    projectId = await uploadProject(httpServer, authToken);
    dataLink = await getDataLinkFixture(app, projectId);
  }, 180_000);

  afterAll(async () => {
    await teardownE2ETest(app);
  });

  beforeEach(async () => {
    await startDesignerSession(httpServer, authToken, projectId);
  }, 30_000);

  afterEach(async () => {
    await endSession(httpServer, authToken, projectId);
  }, 30_000);

  it('returns 400 for a malformed data-link system ID', async () => {
    await request(httpServer as HttpServer)
      .delete(`/arc-api/v1/projects/${projectId}/data-links/not-an-id`)
      .set('Authorization', `Bearer ${authToken}`)
      .timeout(30_000)
      .expect(400);
  });

  it('returns 403 when the project has no active session', async () => {
    await endSession(httpServer, authToken, projectId);

    await request(httpServer as HttpServer)
      .delete(
        `/arc-api/v1/projects/${projectId}/data-links/${dataLink.systemId}`,
      )
      .set('Authorization', `Bearer ${authToken}`)
      .timeout(30_000)
      .expect(403);

    await startDesignerSession(httpServer, authToken, projectId);
  }, 60_000);

  it('returns 403 for a non-Designer session', async () => {
    await endSession(httpServer, authToken, projectId);
    await request(httpServer as HttpServer)
      .post(`/arc-api/v1/projects/${projectId}/start-session`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({mode: 'TUNING'})
      .timeout(30_000)
      .expect(201);

    await request(httpServer as HttpServer)
      .delete(
        `/arc-api/v1/projects/${projectId}/data-links/${dataLink.systemId}`,
      )
      .set('Authorization', `Bearer ${authToken}`)
      .timeout(30_000)
      .expect(403);

    await endSession(httpServer, authToken, projectId);
    await startDesignerSession(httpServer, authToken, projectId);
  }, 60_000);

  it('returns 200 with the deleted link snapshot and stages only its aggregate', async () => {
    const successProjectId = await uploadProject(httpServer, authToken);
    const successDataLink = await getDataLinkFixture(app, successProjectId);
    await startDesignerSession(httpServer, authToken, successProjectId);
    try {
      const response = await request(httpServer as HttpServer)
        .delete(
          `/arc-api/v1/projects/${successProjectId}/data-links/${successDataLink.systemId}`,
        )
        .set('Authorization', `Bearer ${authToken}`)
        .timeout(30_000)
        .expect(200);

      expect(response.body.data).toMatchObject({
        systemId: String(successDataLink.systemId),
        sourceSystemId: String(successDataLink.sourceNodeSystemId),
        sourcePortSystemId: String(successDataLink.sourcePortSystemId),
        destinationSystemId: String(successDataLink.destinationNodeSystemId),
        destinationPortSystemId: String(
          successDataLink.destinationPortSystemId,
        ),
        isInterUsecase: successDataLink.linkType === 'INTER_USECASE',
      });
      expect(response.body.data).not.toHaveProperty('groupId');

      const actions = await getActiveEditActions(app, successProjectId);
      const deletes = actions.filter(action => action.operation === 'DELETE');
      expect(deletes).toEqual(
        expect.arrayContaining([
          {
            targetTable: 'DataLink',
            targetSystemId: successDataLink.systemId,
            operation: 'DELETE',
          },
          ...successDataLink.resolvedSegmentSystemIds.map(targetSystemId => ({
            targetTable: 'SubsystemDataLink',
            targetSystemId,
            operation: 'DELETE',
          })),
        ]),
      );
      expect(
        deletes.some(
          action =>
            action.targetTable === 'SpfModule' ||
            action.targetTable === 'ControlLink' ||
            action.targetTable === 'SubsystemControlLink' ||
            successDataLink.unresolvedSegmentSystemIds.includes(
              Number(action.targetSystemId),
            ),
        ),
      ).toBe(false);
    } finally {
      await forceEndTestSession(app, successProjectId);
    }
  }, 60_000);

  it('returns 404 with a DataLink issue for a missing ID', async () => {
    const existingIds = await getProjectDataLinkIds(app, projectId);
    const missingId = Math.max(...existingIds, 0) + 999_999;
    const response = await request(httpServer as HttpServer)
      .delete(`/arc-api/v1/projects/${projectId}/data-links/${missingId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .timeout(30_000)
      .expect(404);

    expect(response.body).toMatchObject({
      statusCode: 404,
      errorCode: 'RESOURCE_NOT_FOUND',
    });
    expect(response.body.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'ENTITY_NOT_FOUND',
          impactedEntity: {entityType: 'DataLink', systemId: missingId},
        }),
      ]),
    );
  });

  it('returns 404 for a link ID from another project', async () => {
    const secondProjectId = await uploadProject(httpServer, authToken);
    const firstProjectIds = await getProjectDataLinkIds(app, projectId);
    const secondProjectIds = await getProjectDataLinkIds(app, secondProjectId);
    const crossProjectId = secondProjectIds.find(
      id => !firstProjectIds.includes(id),
    );
    if (crossProjectId === undefined) {
      throw new Error('Fixtures did not produce a project-unique data-link ID');
    }

    const response = await request(httpServer as HttpServer)
      .delete(`/arc-api/v1/projects/${projectId}/data-links/${crossProjectId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .timeout(30_000)
      .expect(404);

    expect(response.body).toMatchObject({
      statusCode: 404,
      errorCode: 'RESOURCE_NOT_FOUND',
    });
    expect(response.body.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          impactedEntity: {entityType: 'DataLink', systemId: crossProjectId},
        }),
      ]),
    );
  }, 180_000);
});
