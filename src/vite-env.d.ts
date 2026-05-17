/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GOOGLE_ADS_CLIENT_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
