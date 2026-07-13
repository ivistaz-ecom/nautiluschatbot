/** Client-facing API base URL (browser requests). */
export const API_URL =
  process.env.NEXT_PUBLIC_API_URL || '/api/proxy/v1';

/** Upstream PHP API used by server-side routes and the dev proxy. */
export const API_BACKEND_URL =
  process.env.API_BACKEND_URL || 'https://nautilus.crafttechhub.com/api/v1';

/** Base URL for browser document/PDF links (always the real API host, not the dev proxy). */
export const DOCUMENT_API_URL = API_BACKEND_URL.replace(/\/$/, '');
