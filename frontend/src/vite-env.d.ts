/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API base for the typed client. Empty string = same-origin (CloudFront). */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
