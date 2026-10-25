/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional, non-secret default API base URL. Credentials are never configured at build time. */
  readonly VITE_HOOKRELAY_API_BASE_URL?: string;
}
