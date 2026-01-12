const AUTH_TOKEN_KEY = "pepew_api_token";

export const API_BASE =
  import.meta.env.VITE_API_BASE ?? "https://api.pepepow.net";

export function getApiUrl(path: string) {
  return new URL(path, API_BASE).toString();
}

export function getAuthToken() {
  if (typeof localStorage === "undefined") return "";
  return localStorage.getItem(AUTH_TOKEN_KEY) || "";
}

export function setAuthToken(token: string) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(AUTH_TOKEN_KEY, token);
}

export function clearAuthToken() {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(AUTH_TOKEN_KEY);
}

export async function apiFetch(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers || {});
  const token = getAuthToken();
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return fetch(getApiUrl(path), { ...options, headers });
}
