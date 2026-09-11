/*
 * Copyright (c) Qualcomm Technologies, Inc. and/or its subsidiaries.
 * SPDX-License-Identifier: BSD-3-Clause
 */

import type {Logger} from '../../../../shared/types/logger.interface.js';
import {BinaryUtils} from '../../../../shared/utilities/binary-utils.js';
import {ResourceNotFoundException} from '../../../../shared/exceptions/resource-not-found.exception.js';
import {IssueFactory} from '../../../../shared/issues/factories.js';
import {ISSUE_ENTITY_TYPE} from '../../../../shared/issues/impacted-entity.js';
import {mapDataLink} from '../../usecase/dto/component-collection-dto.js';
import type {CommandHandler} from '../../../orchestration/cqrs/commands/command-handler.js';
import type {UnitOfWork} from '../../../ports/persistence/unit-of-work.js';
import type {DeleteDataLinkCommand} from './delete-data-link.command.js';
import type {DataLinkDto} from '../../usecase/dto/component-collection-dto.js';

export class DeleteDataLinkHandler implements CommandHandler<
  DeleteDataLinkCommand,
  DataLinkDto
> {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly logger?: Logger,
  ) {}

  async handle(command: DeleteDataLinkCommand): Promise<DataLinkDto> {
    await this.uow.startTransaction();
    try {
      const {session} = this.uow.getWriteContext();
      const repository = this.uow.getDataLinkRepository();
      const dataLink = await repository.findBySystemId(
        command.dataLinkSystemId,
        session.fileSystemId,
      );

      if (!dataLink) {
        throw new ResourceNotFoundException(
          `Data link ${command.dataLinkSystemId} was not found.`,
          [
            IssueFactory.notFound(
              ISSUE_ENTITY_TYPE.DataLink,
              command.dataLinkSystemId,
            ),
          ],
        );
      }

      const response = mapDataLink({
        systemId: dataLink.systemId,
        sourceNodeSystemId: dataLink.sourceNodeSystemId,
        destinationNodeSystemId: dataLink.destinationNodeSystemId,
        sourcePortSystemId: dataLink.sourcePortSystemId,
        destinationPortSystemId: dataLink.destinationPortSystemId,
        linkType: dataLink.linkType,
        isEc: dataLink.isEc ?? null,
      });

      await repository.deleteAggregate(dataLink.systemId, session.fileSystemId);
      await this.uow.commit();
      this.logger?.logInfo({
        msg: `Deleted data link (${BinaryUtils.toHexString(dataLink.systemId)})`,
        description: 'Data-link delete committed.',
        component: 'DeleteDataLinkHandler',
        tag: 'data-link-delete',
        timestamp: new Date(),
      });
      return response;
    } catch (error) {
      if (this.uow.isInTransaction()) await this.uow.rollback();
      this.logger?.logError({
        msg: `Delete data link failed (${BinaryUtils.toHexString(command.dataLinkSystemId)})`,
        description: 'Data-link delete rolled back.',
        component: 'DeleteDataLinkHandler',
        tag: 'data-link-delete',
        timestamp: new Date(),
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw error;
    }
  }
}
