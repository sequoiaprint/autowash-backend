import { z } from 'zod';
import { paginationSchema } from '../../core/pagination.js';
import { LIMITS } from '../../infrastructure/mqtt/index.js';

const dateInput = z
  .union([z.iso.datetime({ offset: true }), z.iso.date()])
  .transform((value) => new Date(value));

export const listRunsQuerySchema = paginationSchema
  .extend({
    washNumber: z.coerce.number().int().min(1).max(LIMITS.washes).optional(),
    outcome: z.enum(['IN_PROGRESS', 'COMPLETED', 'STOPPED', 'INTERRUPTED']).optional(),
    from: dateInput.optional(),
    to: dateInput.optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: 'from must not be after to', path: ['from'] });

export const runIdParamsSchema = z.object({ id: z.uuid() });

export type ListRunsQuery = z.infer<typeof listRunsQuerySchema>;
export type RunIdParams = z.infer<typeof runIdParamsSchema>;
