// ============================================================================
// CONFIGURATION MANAGEMENT
// ============================================================================
// Handles loading, saving, and validating configuration from ~/.tx directory.
// Supports both legacy ~/.cx location and new ~/.tx location.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import {
  TxConfig,
  LLMConfig,
  StorageConfig,
  FileStorageConfig,
  SQLiteStorageConfig,
  PostgresStorageConfig,
  DEFAULT_LLM_CONFIG,
  DEFAULT_TX_CONFIG,
} from "../types/index.js";

// ---- Path Constants ----

const TX_DIR = join(homedir(), ".tx");
const TX_CONFIG_PATH = join(TX_DIR, "config.json");
const TX_DATA_DIR = join(TX_DIR, "data");

// Legacy path for backwards compatibility
const LEGACY_CX_DIR = join(homedir(), ".cx");
const LEGACY_CONFIG_PATH = join(LEGACY_CX_DIR, "config.json");

// ---- Config Types for File Format ----

/**
 * Legacy config format (from ~/.cx)
 */
interface LegacyConfig {
  provider: "bedrock" | "openai" | "local";
  bedrock?: {
    model?: string;
    region?: string;
  };
  openai?: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  local?: {
    baseUrl: string;
    model: string;
    apiKey?: string;
  };
}

// ---- Directory Management ----

/**
 * Ensure the .tx directory structure exists
 */
export function ensureConfigDirectories(): void {
  for (const dir of [TX_DIR, TX_DATA_DIR]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

/**
 * Get the base .tx directory path
 */
export function getConfigDir(): string {
  return TX_DIR;
}

/**
 * Get the data directory path
 */
export function getDataDir(): string {
  return TX_DATA_DIR;
}

// ---- Config Loading ----

/**
 * Load configuration from ~/.tx/config.json
 * Falls back to legacy ~/.cx/config.json if .tx doesn't exist
 */
export function loadConfig(): TxConfig {
  ensureConfigDirectories();

  // Try loading from new location first
  if (existsSync(TX_CONFIG_PATH)) {
    try {
      const raw = readFileSync(TX_CONFIG_PATH, "utf-8");
      const parsed = JSON.parse(raw) as TxConfig;
      return validateAndNormalizeConfig(parsed);
    } catch (error) {
      console.error(`\x1b[31mError reading config from ${TX_CONFIG_PATH}\x1b[0m`);
      console.error(`\x1b[31m${error}\x1b[0m`);
      process.exit(1);
    }
  }

  // Try loading from legacy location
  if (existsSync(LEGACY_CONFIG_PATH)) {
    try {
      const raw = readFileSync(LEGACY_CONFIG_PATH, "utf-8");
      const legacy = JSON.parse(raw) as LegacyConfig;
      const config = migrateLegacyConfig(legacy);
      
      // Save to new location
      saveConfig(config);
      console.log(`\x1b[33mMigrated config from ${LEGACY_CONFIG_PATH} to ${TX_CONFIG_PATH}\x1b[0m`);
      
      return config;
    } catch (error) {
      console.error(`\x1b[31mError reading legacy config from ${LEGACY_CONFIG_PATH}\x1b[0m`);
      // Fall through to create default
    }
  }

  // Create default config
  const defaultConfig = createDefaultConfig();
  saveConfig(defaultConfig);
  console.log(`\x1b[33mCreated default config at ${TX_CONFIG_PATH}\x1b[0m`);
  
  return defaultConfig;
}

/**
 * Save configuration to ~/.tx/config.json
 */
export function saveConfig(config: TxConfig): void {
  ensureConfigDirectories();
  writeFileSync(TX_CONFIG_PATH, JSON.stringify(config, null, 2));
}

/**
 * Get the path to the config file
 */
export function getConfigPath(): string {
  return TX_CONFIG_PATH;
}

// ---- Config Creation ----

/**
 * Create a default configuration
 */
export function createDefaultConfig(): TxConfig {
  const storage: FileStorageConfig = {
    type: "file",
    basePath: TX_DATA_DIR,
  };

  return {
    llm: { ...DEFAULT_LLM_CONFIG },
    storage,
  };
}

/**
 * Migrate legacy ~/.cx config to new format
 */
function migrateLegacyConfig(legacy: LegacyConfig): TxConfig {
  const llm: LLMConfig = {
    provider: legacy.provider || "bedrock",
    bedrock: legacy.bedrock,
    openai: legacy.openai,
    local: legacy.local,
  };

  // Use new storage location
  const storage: FileStorageConfig = {
    type: "file",
    basePath: TX_DATA_DIR,
  };

  return { llm, storage };
}

/**
 * Validate and normalize a config object
 */
function validateAndNormalizeConfig(config: Partial<TxConfig>): TxConfig {
  // Ensure LLM config exists
  if (!config.llm) {
    config.llm = { ...DEFAULT_LLM_CONFIG };
  }

  // Ensure provider is set
  if (!config.llm.provider) {
    config.llm.provider = "bedrock";
  }

  // Ensure storage config exists
  if (!config.storage) {
    config.storage = {
      type: "file",
      basePath: TX_DATA_DIR,
    };
  }

  // Validate storage config type
  if (!["file", "sqlite", "postgres"].includes(config.storage.type)) {
    throw new Error(`Invalid storage type: ${config.storage.type}`);
  }

  // Ensure file storage has basePath
  if (config.storage.type === "file" && !(config.storage as FileStorageConfig).basePath) {
    (config.storage as FileStorageConfig).basePath = TX_DATA_DIR;
  }

  return config as TxConfig;
}

// ---- Config Helpers ----

/**
 * Create a file storage config
 */
export function createFileStorageConfig(basePath?: string): FileStorageConfig {
  return {
    type: "file",
    basePath: basePath || TX_DATA_DIR,
  };
}

/**
 * Create a SQLite storage config
 */
export function createSQLiteStorageConfig(path?: string): SQLiteStorageConfig {
  return {
    type: "sqlite",
    path: path || join(TX_DATA_DIR, "tx.db"),
  };
}

/**
 * Create a PostgreSQL storage config
 */
export function createPostgresStorageConfig(options: {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean;
}): PostgresStorageConfig {
  return {
    type: "postgres",
    host: options.host || "localhost",
    port: options.port || 5432,
    database: options.database || "tx",
    user: options.user || "tx",
    password: options.password || "",
    ssl: options.ssl ?? false,
  };
}

/**
 * Update the storage configuration
 */
export function updateStorageConfig(config: TxConfig, storage: StorageConfig): TxConfig {
  return {
    ...config,
    storage,
  };
}

/**
 * Update the LLM configuration
 */
export function updateLLMConfig(config: TxConfig, llm: Partial<LLMConfig>): TxConfig {
  return {
    ...config,
    llm: {
      ...config.llm,
      ...llm,
    },
  };
}

// ---- Display Helpers ----

/**
 * Get the current scope from config
 */
export function getCurrentScope(config: TxConfig): string | undefined {
  return config.currentScope;
}

/**
 * Set the current scope in config
 */
export function setCurrentScope(config: TxConfig, scopeId: string | null): TxConfig {
  const updated = { ...config };
  if (scopeId === null) {
    delete updated.currentScope;
  } else {
    updated.currentScope = scopeId;
  }
  saveConfig(updated);
  return updated;
}

/**
 * Get a human-readable description of the current config
 */
export function describeConfig(config: TxConfig): string {
  const lines: string[] = [];
  
  // LLM
  lines.push(`LLM Provider: ${config.llm.provider}`);
  
  switch (config.llm.provider) {
    case "bedrock":
      lines.push(`  Model: ${config.llm.bedrock?.model || "default"}`);
      lines.push(`  Region: ${config.llm.bedrock?.region || "default"}`);
      break;
    case "openai":
      lines.push(`  Base URL: ${config.llm.openai?.baseUrl || "not set"}`);
      lines.push(`  Model: ${config.llm.openai?.model || "not set"}`);
      break;
    case "local":
      lines.push(`  Base URL: ${config.llm.local?.baseUrl || "not set"}`);
      lines.push(`  Model: ${config.llm.local?.model || "not set"}`);
      break;
  }
  
  // Current scope
  if (config.currentScope) {
    lines.push(`Current Scope: ${config.currentScope}`);
  } else {
    lines.push(`Current Scope: (none - global)`);
  }
  
  // Storage
  lines.push(`Storage: ${config.storage.type}`);
  
  switch (config.storage.type) {
    case "file":
      lines.push(`  Path: ${(config.storage as FileStorageConfig).basePath}`);
      break;
    case "sqlite":
      lines.push(`  Database: ${(config.storage as SQLiteStorageConfig).path}`);
      break;
    case "postgres":
      const pg = config.storage as PostgresStorageConfig;
      lines.push(`  Host: ${pg.host}:${pg.port}`);
      lines.push(`  Database: ${pg.database}`);
      lines.push(`  User: ${pg.user}`);
      lines.push(`  SSL: ${pg.ssl ? "enabled" : "disabled"}`);
      break;
  }
  
  return lines.join("\n");
}

