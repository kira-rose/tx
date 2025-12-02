// ============================================================================
// STORAGE MODULE EXPORTS
// ============================================================================
// Central export point for storage implementations and factory.

export type { IStorage, StorageFactory } from "./interface.js";
export { BaseStorage } from "./interface.js";
export { FileStorage } from "./file.js";
export { SQLiteStorage } from "./sqlite.js";
export { PostgresStorage } from "./postgres.js";

import { IStorage } from "./interface.js";
import { FileStorage } from "./file.js";
import { SQLiteStorage } from "./sqlite.js";
import { PostgresStorage } from "./postgres.js";
import {
  StorageConfig,
  FileStorageConfig,
  SQLiteStorageConfig,
  PostgresStorageConfig,
} from "../types/index.js";

/**
 * Factory function to create the appropriate storage backend
 * based on configuration.
 */
export function createStorage(config: StorageConfig): IStorage {
  switch (config.type) {
    case "file":
      return new FileStorage(config as FileStorageConfig);
    case "sqlite":
      return new SQLiteStorage(config as SQLiteStorageConfig);
    case "postgres":
      return new PostgresStorage(config as PostgresStorageConfig);
    default:
      throw new Error(`Unknown storage type: ${(config as StorageConfig).type}`);
  }
}

/**
 * Helper to get the storage type name for display
 */
export function getStorageTypeName(config: StorageConfig): string {
  switch (config.type) {
    case "file":
      return `File (${(config as FileStorageConfig).basePath})`;
    case "sqlite":
      return `SQLite (${(config as SQLiteStorageConfig).path})`;
    case "postgres":
      const pg = config as PostgresStorageConfig;
      return `PostgreSQL (${pg.host}:${pg.port}/${pg.database})`;
    default:
      return "Unknown";
  }
}


