/**
 * Configuration for the SDK generator frontend.
 *
 * Controls how the OpenAPI spec is parsed and how the SDK AST is structured.
 */
export interface FrontendConfig {
  /** SDK package name (e.g., "archastro-platform") */
  name: string;
  /** SDK version (independent from API version) */
  version: string;
  /** Optional description */
  description?: string;
  /** Base URL for the API (e.g., "https://platform.archastro.ai") */
  baseUrl: string;
  /**
   * API base path without version (e.g., "/api").
   * When set, versions are auto-detected from path prefixes like /api/v1/, /api/v2/.
   */
  apiBase?: string;
  /** Default API version for convenience aliases (e.g., "v1"). Used with apiBase. */
  defaultVersion?: string;
  /**
   * @deprecated Use apiBase + defaultVersion instead.
   * Single API path prefix (e.g., "/api/v1"). Falls back to single-version mode.
   */
  apiPrefix?: string;
  /** Scope prefix after apiPrefix (e.g., "/apps/{app_id}") */
  scopePrefix?: string;
  /** Override operation names by operationId */
  operationOverrides?: Record<string, { name?: string; parent?: string }>;
  /** Override resource grouping */
  resourceOverrides?: Record<string, { parent?: string; name?: string }>;
  /** Paths to exclude from the generated SDK (glob patterns) */
  ignorePaths?: string[];
}

export const DEFAULT_CONFIG: Partial<FrontendConfig> = {
  name: "archastro-platform",
  version: "0.1.0",
  baseUrl: "https://platform.archastro.ai",
  apiPrefix: "",
  apiBase: "",
  defaultVersion: "v1",
};
