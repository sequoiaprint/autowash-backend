-- CreateTable
CREATE TABLE `wash_runs` (
    `id` CHAR(36) NOT NULL,
    `washNumber` INTEGER NOT NULL,
    `outcome` ENUM('IN_PROGRESS', 'COMPLETED', 'STOPPED', 'INTERRUPTED') NOT NULL DEFAULT 'IN_PROGRESS',
    `startedAt` DATETIME(3) NOT NULL,
    `endedAt` DATETIME(3) NULL,
    `totalSeconds` INTEGER NOT NULL,
    `elapsedSeconds` INTEGER NOT NULL DEFAULT 0,
    `breakCount` INTEGER NOT NULL DEFAULT 0,
    `pauseCount` INTEGER NOT NULL DEFAULT 0,
    `linkPauseCount` INTEGER NOT NULL DEFAULT 0,
    `sequenceSnapshot` JSON NOT NULL,
    `timingSnapshot` JSON NOT NULL,
    `recovered` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `wash_runs_startedAt_idx`(`startedAt`),
    INDEX `wash_runs_washNumber_startedAt_idx`(`washNumber`, `startedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `config_change_logs` (
    `id` CHAR(36) NOT NULL,
    `requestId` VARCHAR(32) NULL,
    `changeType` ENUM('SEQUENCE', 'TIMING', 'EXTERNAL') NOT NULL,
    `washNumber` INTEGER NULL,
    `previousConfig` JSON NULL,
    `requestedConfig` JSON NOT NULL,
    `result` ENUM('APPLIED', 'REJECTED', 'TIMED_OUT', 'DETECTED') NOT NULL,
    `errorCode` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `config_change_logs_requestId_key`(`requestId`),
    INDEX `config_change_logs_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
