/*
 * Copyright (c) Qualcomm Technologies, Inc. and/or its subsidiaries.
 * SPDX-License-Identifier: BSD-3-Clause
 */
import type {UnitOfWork} from '../../../ports/persistence/unit-of-work.js';
import type {IdGenerationPort} from '../../../ports/id-generation/id-generation.port.js';
import {ResourceNotFoundException} from '../../../../shared/exceptions/index.js';
import {Result} from '../../../shared/result/result.js';
import {KvData} from '../../../../domain/entities/common/entities/kv-data.js';
import {ModuleParameterData} from '../../../../domain/entities/common/value-objects/module-parameter-data.js';
import {TOOL_POLICY} from '../../../../domain/entities/definitions/common/types/tool-policy-type.js';
import {serializeDefaultParameterData} from '../../shared/serialize-elements.js';
import type {RemoveCkvParametersCommand} from './remove-ckv-parameters.command.js';

export interface RemoveCkvParametersResult {
  groupId: string;
  removedParameterSystemIds: number[];
  removedCkvSystemIds: number[];
  affectedCkvSystemIds: number[];
}

export class RemoveCkvParametersHandler {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly idGeneration: IdGenerationPort,
  ) {}

  async handle(
    command: RemoveCkvParametersCommand,
  ): Promise<Result<RemoveCkvParametersResult>> {
    const {session, groupId} = this.uow.getWriteContext();
    const {fileSystemId} = session;
    const moduleRepo = this.uow.getModuleRepository();
    const defRepo = this.uow.getModuleDefinitionRepository();

    const spfModule = await moduleRepo.getSpfModuleForValidation(
      command.spfModuleSystemId,
      fileSystemId,
    );
    if (!spfModule) throw new ResourceNotFoundException('SpfModule not found');

    const allCkvs = await moduleRepo.getAllCkvsForModule(
      command.spfModuleSystemId,
      fileSystemId,
    );
    const ckvPayloadMap = await moduleRepo.getAllCkvParameterPayloads(
      command.spfModuleSystemId,
    );

    await this.uow.startTransaction();
    try {
      const removedParameterSystemIds: number[] = [];
      const removedCkvSystemIds: number[] = [];
      const affectedCkvSystemIds: number[] = [];

      // Track remaining payload counts per CKV after removals
      const remainingPayloadCount = new Map<number, number>();
      for (const [ckvId, payloads] of ckvPayloadMap) {
        remainingPayloadCount.set(ckvId, payloads.length);
      }

      for (const parameterSystemId of command.parameterSystemIds) {
        const nonZeroCkvs = allCkvs.filter(
          c => c.valueDefinitionSystemIds.length > 0,
        );
        for (const ckv of nonZeroCkvs) {
          const payloads = ckvPayloadMap.get(ckv.systemId) ?? [];
          const payloadRow = payloads.find(
            p => p.parameterSystemId === parameterSystemId,
          );
          if (!payloadRow) continue;
          await moduleRepo.removeParameterFromCkv(
            payloadRow.systemId,
            ckv.systemId,
            command.spfModuleSystemId,
          );
          const prev = remainingPayloadCount.get(ckv.systemId) ?? 0;
          remainingPayloadCount.set(ckv.systemId, prev - 1);
          if (!affectedCkvSystemIds.includes(ckv.systemId)) {
            affectedCkvSystemIds.push(ckv.systemId);
          }
        }
        removedParameterSystemIds.push(parameterSystemId);
      }

      // Remove CKVs with zero remaining payloads
      for (const [ckvId, count] of remainingPayloadCount) {
        const ckv = allCkvs.find(c => c.systemId === ckvId);
        if (!ckv || ckv.valueDefinitionSystemIds.length === 0) continue;
        if (count <= 0) {
          await moduleRepo.removeCkv(ckvId, command.spfModuleSystemId);
          removedCkvSystemIds.push(ckvId);
        }
      }

      // Restore zero CKV if no non-zero CKVs remain
      const remainingNonZero = allCkvs.filter(
        c =>
          c.valueDefinitionSystemIds.length > 0 &&
          !removedCkvSystemIds.includes(c.systemId),
      );
      if (remainingNonZero.length === 0) {
        const allDefs = await defRepo.getParameterDefinitions(
          spfModule.definitionSystemId,
        );
        const calibrationDefs = allDefs.filter(
          d =>
            d.toolPolicy === TOOL_POLICY.Calibration &&
            !command.parameterSystemIds.includes(d.systemId),
        );
        const zeroCkvSystemId = await this.idGeneration.getNextId(fileSystemId);
        const kvData = new KvData({
          systemId: zeroCkvSystemId,
          valueDefinitionSystemIds: [],
          uiPersistence: null,
        });
        for (const def of calibrationDefs) {
          if (def.isReadOnly) continue;
          const serialized = serializeDefaultParameterData(def);
          if (!serialized.ok) continue;
          const payloadSystemId =
            await this.idGeneration.getNextId(fileSystemId);
          const paramData = new ModuleParameterData(
            def.systemId as any,
            serialized.value,
          );
          paramData.payloadSystemId = payloadSystemId;
          kvData.addParameterPayload(paramData);
        }
        await moduleRepo.createCkv(kvData, command.spfModuleSystemId);
      }

      await this.uow.commit();
      return Result.ok({
        groupId,
        removedParameterSystemIds,
        removedCkvSystemIds,
        affectedCkvSystemIds,
      });
    } catch (error) {
      if (this.uow.isInTransaction()) await this.uow.rollback();
      throw error;
    }
  }
}
