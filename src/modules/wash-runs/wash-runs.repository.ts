import type { Page } from '../../core/pagination.js';
import type { PrismaClient } from '../../core/prisma.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { NewWashRun, WashRun, WashRunFilter, WashRunPatch, WashRunStore } from './wash-runs.types.js';

const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

export class WashRunRepository implements WashRunStore {
  constructor(private readonly prisma: PrismaClient) {}

  findOpen(): Promise<WashRun | null> {
    return this.prisma.washRun.findFirst({
      where: { outcome: 'IN_PROGRESS' },
      orderBy: { startedAt: 'desc' },
    });
  }

  create(run: NewWashRun): Promise<WashRun> {
    return this.prisma.washRun.create({
      data: {
        ...run,
        sequenceSnapshot: json(run.sequenceSnapshot),
        timingSnapshot: json(run.timingSnapshot),
      },
    });
  }

  update(id: string, patch: WashRunPatch): Promise<WashRun> {
    return this.prisma.washRun.update({ where: { id }, data: patch });
  }

  findById(id: string): Promise<WashRun | null> {
    return this.prisma.washRun.findUnique({ where: { id } });
  }

  async list(filter: WashRunFilter, page: number, limit: number): Promise<Page<WashRun>> {
    const where: Prisma.WashRunWhereInput = {
      ...(filter.washNumber !== undefined ? { washNumber: filter.washNumber } : {}),
      ...(filter.outcome ? { outcome: filter.outcome } : {}),
      ...(filter.from || filter.to
        ? { startedAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.washRun.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.washRun.count({ where }),
    ]);
    return { items, page, limit, total };
  }
}
