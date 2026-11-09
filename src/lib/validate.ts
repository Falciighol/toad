// Field validation is the engine's (`validate_test`), so the UI and a run agree exactly.
// This module only keeps the client-side helpers the editor needs between round trips.

export const SENSITIVE_HEADERS = ["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key"];
export const isSensitiveHeader = (name: string) => SENSITIVE_HEADERS.includes(name.trim().toLowerCase());

/** JSON with every {{placeholder}} filled by 0, so templated bodies can be syntax-checked. */
export function jsonError(text: string): string | null {
  if (!text.trim()) return null;
  try {
    JSON.parse(text.replace(/\{\{[^}]*\}\}/g, "0"));
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "Not valid JSON";
  }
}
