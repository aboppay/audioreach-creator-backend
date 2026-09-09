/*
 * Copyright (c) Qualcomm Technologies, Inc. and/or its subsidiaries.
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {BaseQuery} from '../../../shared/base-query.js';
import {parseId} from '../../shared/parse-id.js';

export class GetVcpmCalDataQuery extends BaseQuery {
  public readonly projectId: number;
  public readonly subgraphSystemId: number;
  public readonly ckvSystemId: number;
  public readonly paramSystemIds: number[];

  constructor(
    projectIdStr: string,
    subgraphSystemIdStr: string,
    ckvSystemIdStr: string,
    clientId: string,
    paramSystemIdsStr?: string,
  ) {
    super(clientId);
    this.projectId = parseId(projectIdStr, 'projectId');
    this.subgraphSystemId = parseId(subgraphSystemIdStr, 'subgraphSystemId');
    this.ckvSystemId = parseId(ckvSystemIdStr, 'ckvSystemId');
    this.paramSystemIds = paramSystemIdsStr
      ? paramSystemIdsStr
          .split(',')
          .map(id => parseId(id.trim(), 'param-system-ids'))
      : [];
  }
}
