import { html, useState, useEffect, useCallback } from "./vendor/preact-htm.js";

export const enc = encodeURIComponent;

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || (data.errors || []).join("\n") || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// One SSE connection; live components re-fetch whenever flowd says something changed.
const listeners = new Set();
let version = 0;
new EventSource("/api/stream").onmessage = () => {
  version++;
  for (const fn of listeners) fn(version);
};

export function useData(path, live = true) {
  const [state, setState] = useState({ data: null, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!live) return undefined;
    listeners.add(setTick);
    return () => listeners.delete(setTick);
  }, [live]);
  const load = useCallback(() => {
    if (!path) return Promise.resolve();
    return api("GET", path).then((data) => setState({ data, error: null }), (error) => setState({ data: null, error }));
  }, [path]);
  useEffect(() => { load(); }, [load, tick]);
  return { ...state, reload: load };
}

/** Re-renders every 30 s so "12 min" keeps counting between server events. */
export function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(i);
  }, []);
  return now;
}

export function useRoute() {
  const read = () => (location.hash || "#/runs").slice(2).split("/").map(decodeURIComponent);
  const [route, setRoute] = useState(read());
  useEffect(() => {
    const on = () => setRoute(read());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return route;
}

export const go = (...parts) => { location.hash = `#/${parts.map(enc).join("/")}`; };
/** Runs an action. A failure goes to `onError` to be shown inline; without one (the editors), to alert(). */
export const attempt = (fn, onError) => async (...args) => {
  try {
    if (onError) onError(null);
    await fn(...args);
  } catch (e) {
    if (onError) onError(e.message);
    else alert(e.message);
  }
};
export const focus = (sid, onError) => attempt(() => api("POST", `/api/sessions/${enc(sid)}/focus`), onError);
export const isUrl = (v) => /^https?:\/\//.test(String(v));
export const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "" && v !== null));
// selected on the option itself: the lists arrive after the <select> first renders
export const options = (items, value) => items.map((x) => html`<option value=${x} selected=${x === value}>${x}</option>`);
export const sessionLabel = (s) => `${s.workspace} / ${s.name || s.title || s.id.slice(0, 8)}`;

const PATHS = {
  agent: html`<rect x="4" y="8" width="16" height="12" rx="3" /><path d="M12 8V4" /><circle cx="9" cy="14" r="1" /><circle cx="15" cy="14" r="1" />`,
  you: html`<circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 4-6 8-6s8 2 8 6" />`,
  wait: html`<circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />`,
  check: html`<path d="M5 12l5 5L19 7" />`,
  cross: html`<path d="M6 6l12 12M18 6L6 18" />`,
  alert: html`<path d="M12 3l10 18H2z" /><path d="M12 10v5M12 18v.5" />`,
  terminal: html`<rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9l3 3-3 3M13 15h4" />`,
  external: html`<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />`,
  again: html`<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />`,
};
export const Icon = ({ name, size = 20 }) => html`<svg class="ic" width=${size} height=${size} viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`;

export const Err = ({ msg }) => (msg ? html`<p class="err-box" role="alert">${msg}</p>` : null);
