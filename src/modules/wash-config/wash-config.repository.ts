import type { Page } from '../../core/pagination.js';
import type { PrismaClient } from '../../core/prisma.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { ConfigChangeLog, NewConfigChangeLog } from './wash-config.types.js';

const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

export class WashConfigRepository {
  constructor(private readonly prisma: PrismaClient) {}

  create(entry: NewConfigChangeLog): Promise<ConfigChangeLog> {
    return this.prisma.configChangeLog.create({
      data: {
        requestId: entry.requestId,
        changeType: entry.changeType,
        washNumber: entry.washNumber,
        ...(entry.previousConfig === null || entry.previousConfig === undefined
          ? {}
          : { previousConfig: json(entry.previousConfig) }),
        requestedConfig: json(entry.requestedConfig),
        result: entry.result,
        errorCode: entry.errorCode,
      },
    });
  }

  async list(page: number, limit: number): Promise<Page<ConfigChangeLog>> {
    const [items, total] = await Promise.all([
      this.prisma.configChangeLog.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.configChangeLog.count(),
    ]);
    return { items, page, limit, total };
  }
}
