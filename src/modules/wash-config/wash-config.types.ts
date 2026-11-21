import type { ConfigChangeLog } from '../../generated/prisma/client.js';
import type { ConfigChangeResult, ConfigChangeType } from '../../generated/prisma/enums.js';

export type { ConfigChangeLog, ConfigChangeResult, ConfigChangeType };

export interface NewConfigChangeLog {
  requestId: string | null;
  changeType: ConfigChangeType;
  washNumber: number | null;
  previousConfig: unknown;
  requestedConfig: unknown;
  result: ConfigChangeResult;
  errorCode: string | null;
}
