import { z } from 'zod';

import { configSchema } from './schema.js';

/**
 * JSON Schema is derived from the same Zod schema used at runtime
 * (docs/05-data-model.md 5.8.1, checklist D03). There is no second schema.
 */
export function configJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(configSchema, {
    io: 'input',
    unrepresentable: 'throw',
  }) as unknown;
  if (typeof schema !== 'object' || schema === null) {
    return { type: 'object' };
  }
  return schema as Record<string, unknown>;
}
