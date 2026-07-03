const DEFAULT_PROFILE_BACKEND_URL = "http://127.0.0.1:4003";

export const PROFILE_BACKEND_BASE_URL =
  process.env.NEXT_PUBLIC_PROFILE_BACKEND_URL ?? DEFAULT_PROFILE_BACKEND_URL;

export function profileBackendUrl(path: string) {
  return `${PROFILE_BACKEND_BASE_URL.replace(/\/$/, "")}${path}`;
}
