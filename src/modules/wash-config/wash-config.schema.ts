import { z } from 'zod';
import { paginationSchema } from '../../core/pagination.js';
import { LIMITS, sequenceSchema, timingSchema } from '../../infrastructure/mqtt/index.js';

export const washNumberParamsSchema = z.object({
  washNumber: z.coerce.number().int().min(1).max(LIMITS.washes),
});

export const saveSequenceBodySchema = z.object({ steps: sequenceSchema }).strict();
export const saveTimingBodySchema = z.object({ timing: timingSchema }).strict();
export const historyQuerySchema = paginationSchema;

export type WashNumberParams = z.infer<typeof washNumberParamsSchema>;
export type SaveSequenceBody = z.infer<typeof saveSequenceBodySchema>;
export type SaveTimingBody = z.infer<typeof saveTimingBodySchema>;
export type HistoryQuery = z.infer<typeof historyQuerySchema>;
