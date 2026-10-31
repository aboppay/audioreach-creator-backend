/*
 * Copyright (c) Qualcomm Technologies, Inc. and/or its subsidiaries.
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {CHANGE_STATUS} from '../../shared/change-vocabulary.js';
import type {CommandHandler} from '../../orchestration/cqrs/commands/command-handler.js';
import type {UnitOfWork} from '../../ports/persistence/unit-of-work.js';
import {Result} from '../../shared/result/result.js';
import {DomainRuleViolationException} from '../../../shared/exceptions/index.js';
import {ISSUE_CODE} from '../../../shared/issues/operational-codes.js';
import {IssueSeverity} from '../../../shared/issues/severity.js';
import {BinaryUtils} from '../../../shared/utilities/binary-utils.js';
import type {UnstageChangesCommand} from './unstage-changes.command.js';

export class UnstageChangesHandler
  implements CommandHandler<UnstageChangesCommand, Result<Record<string, never>>>
{
  constructor(private readonly uow: UnitOfWork) {}

  async handle(
    command: UnstageChangesCommand,
  ): Promise<Result<Record<string, never>>> {
    await this.uow.startTransaction();
    try {
      const ctx = this.uow.getWriteContext();
      const found = await this.uow
        .getSessionRepository()
        .updateChangeStatusByEntitySystemIds(
          ctx.session.sessionId,
          command.targetTable,
          command.systemIds,
          CHANGE_STATUS.Unstaged,
        );

      if (found.length < command.systemIds.length) {
        const foundSet = new Set(found);
        const missing = command.systemIds.filter(id => !foundSet.has(id));
        throw new DomainRuleViolationException([
          {
            code: ISSUE_CODE.ENTITY_NOT_FOUND,
            severity: IssueSeverity.Error,
            message: `No pending changes found for systemIds: ${missing.map(id => BinaryUtils.toHexString(id)).join(', ')}`,
          },
        ]);
      }

      await this.uow.commit();
      return Result.ok({});
    } catch (error) {
      if (this.uow.isInTransaction()) await this.uow.rollback();
      throw error;
    }
  }
}
