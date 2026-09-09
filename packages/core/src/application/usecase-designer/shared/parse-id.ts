/*
 * Copyright (c) Qualcomm Technologies, Inc. and/or its subsidiaries.
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {InvalidOperationException} from '../../../shared/exceptions/invalid-operation.exception.js';

export function parseId(value: string, paramName: string): number {
  const trimmed = value.trim();
  const num =
    trimmed.startsWith('0x') || trimmed.startsWith('0X')
      ? Number.parseInt(trimmed, 16)
      : Number.parseInt(trimmed, 10);
  if (Number.isNaN(num) || !Number.isFinite(num)) {
    throw new InvalidOperationException(
      `${paramName} must be an integer, got: ${value}`,
    );
  }
  if (num <= 0) {
    throw new InvalidOperationException(
      `${paramName} must be positive, got: ${value}`,
    );
  }
  return num;
}
