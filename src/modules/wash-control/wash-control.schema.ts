import { z } from 'zod';
import { LIMITS } from '../../infrastructure/mqtt/index.js';

export const startBodySchema = z.object({ wash: z.number().int().min(1).max(LIMITS.washes) }).strict();
export type StartBody = z.infer<typeof startBodySchema>;
