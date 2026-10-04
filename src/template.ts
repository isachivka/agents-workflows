import type { Dict } from "./types.ts";

export class RenderError extends Error {}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

export function renderTemplate(text: string, data: Dict): string {
  return text.replace(PLACEHOLDER, (_m, path: string) => {
    let value: unknown = data;
    for (const key of path.split(".")) {
      value = value !== null && typeof value === "object" ? (value as Dict)[key] : undefined;
    }
    if (value === undefined || value === null) throw new RenderError(`{{${path}}} has no value`);
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  });
}
