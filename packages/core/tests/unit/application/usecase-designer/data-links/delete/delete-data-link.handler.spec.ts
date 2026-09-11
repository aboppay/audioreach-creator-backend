/*
 * Copyright (c) Qualcomm Technologies, Inc. and/or its subsidiaries.
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {describe, expect, it, jest} from '@jest/globals';
import {
  DataLink,
  LINK_TYPE,
  type DataLinkRepository,
  type UnitOfWork,
} from '@arc/core';
import {DeleteDataLinkCommand} from '../../../../../../src/application/usecase-designer/data-links/delete/delete-data-link.command.js';
import {DeleteDataLinkHandler} from '../../../../../../src/application/usecase-designer/data-links/delete/delete-data-link.handler.js';

const FILE_ID = 7;
const DATA_LINK_ID = 500;
const GROUP_ID = 'test-group';

const effectiveLink = new DataLink({
  systemId: DATA_LINK_ID,
  sourceNodeSystemId: 201,
  destinationNodeSystemId: 202,
  sourcePortSystemId: 301,
  destinationPortSystemId: 302,
  linkType: LINK_TYPE.InterUsecase,
  sourceSubgraphSystemId: 401,
  destSubgraphSystemId: 402,
  isEc: false,
  fileSystemId: FILE_ID,
});

function createFixture(dataLink: DataLink | null = effectiveLink): {
  handler: DeleteDataLinkHandler;
  uow: jest.Mocked<UnitOfWork>;
  dataLinkRepository: jest.Mocked<DataLinkRepository>;
} {
  const dataLinkRepository = {
    findBySystemId: jest.fn().mockResolvedValue(dataLink),
    deleteAggregate: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<DataLinkRepository>;
  const uow = {
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commit: jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined),
    isInTransaction: jest.fn().mockReturnValue(true),
    getWriteContext: jest.fn().mockReturnValue({
      session: {sessionId: 11, fileSystemId: FILE_ID},
      groupId: GROUP_ID,
    }),
    getDataLinkRepository: jest.fn().mockReturnValue(dataLinkRepository),
  } as unknown as jest.Mocked<UnitOfWork>;

  return {
    handler: new DeleteDataLinkHandler(uow),
    uow,
    dataLinkRepository,
  };
}

describe('DeleteDataLinkHandler', () => {
  it('deletes the aggregate and returns the canonical snapshot', async () => {
    const {handler, uow, dataLinkRepository} = createFixture();

    await expect(
      handler.handle(new DeleteDataLinkCommand(DATA_LINK_ID)),
    ).resolves.toEqual({
      systemId: String(DATA_LINK_ID),
      sourceSystemId: '201',
      sourcePortSystemId: '301',
      destinationSystemId: '202',
      destinationPortSystemId: '302',
      isInterUsecase: true,
    });

    expect(uow.startTransaction).toHaveBeenCalledTimes(1);
    expect(dataLinkRepository.findBySystemId).toHaveBeenCalledWith(
      DATA_LINK_ID,
      FILE_ID,
    );
    expect(dataLinkRepository.deleteAggregate).toHaveBeenCalledWith(
      DATA_LINK_ID,
      FILE_ID,
    );
    expect(uow.commit).toHaveBeenCalledTimes(1);
    expect(uow.rollback).not.toHaveBeenCalled();
  });

  it('returns a DataLink not-found issue and rolls back when lookup is empty', async () => {
    const {handler, uow, dataLinkRepository} = createFixture(null);

    await expect(
      handler.handle(new DeleteDataLinkCommand(DATA_LINK_ID)),
    ).rejects.toMatchObject({
      errorCode: 'RESOURCE_NOT_FOUND',
      issues: [
        expect.objectContaining({
          code: 'ENTITY_NOT_FOUND',
          impactedEntity: {entityType: 'DataLink', systemId: DATA_LINK_ID},
        }),
      ],
    });

    expect(uow.rollback).toHaveBeenCalledTimes(1);
    expect(dataLinkRepository.deleteAggregate).not.toHaveBeenCalled();
    expect(uow.commit).not.toHaveBeenCalled();
  });

  it('rolls back and rethrows repository failures', async () => {
    const {handler, uow, dataLinkRepository} = createFixture();
    dataLinkRepository.deleteAggregate.mockRejectedValue(
      new Error('write failed'),
    );

    await expect(
      handler.handle(new DeleteDataLinkCommand(DATA_LINK_ID)),
    ).rejects.toThrow('write failed');

    expect(uow.rollback).toHaveBeenCalledTimes(1);
    expect(uow.commit).not.toHaveBeenCalled();
  });
});
