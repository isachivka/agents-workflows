import type { Answer } from "./types.ts";

/**
 * `flow ask`: the agent's fragment (named inputs, `choice` radios or checkboxes, a `note`) wrapped into a
 * page that saves a draft as the person ticks, sends the answer, and comes back as it was left. The same
 * fragment works in the agterm question overlay, and the answer has the overlay's shape.
 */
export function askPage(fragment: string, title: string): string {
  const note = /\bname\s*=\s*["']?note\b/i.test(fragment)
    ? ""
    : `<section class="flow-note"><h2>Comment</h2><textarea name="note" rows="4" placeholder="Anything to add (optional)"></textarea></section>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; --fg: #1d1d1f; --bg: #fff; --muted: #6e6e73; --line: #d2d2d7; --accent: #0a66d8; }
  @media (prefers-color-scheme: dark) { :root { --fg: #f5f5f7; --bg: #161617; --muted: #a1a1a6; --line: #3a3a3c; --accent: #4c9bff; } }
  body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 16px/1.5 -apple-system, system-ui, sans-serif; }
  main { max-width: 760px; margin: 0 auto; }
  textarea, input[type=text] { width: 100%; box-sizing: border-box; font: inherit; color: inherit; background: transparent; border: 1px solid var(--line); border-radius: 8px; padding: 8px; }
  .flow-bar { position: sticky; bottom: 0; display: flex; gap: 12px; align-items: center; padding: 12px 0; background: var(--bg); border-top: 1px solid var(--line); margin-top: 24px; }
  .flow-bar button { font: inherit; font-weight: 600; padding: 10px 22px; border: 0; border-radius: 8px; background: var(--accent); color: #fff; }
  .flow-bar button:disabled { opacity: .5; }
  #flow-status { color: var(--muted); }
</style>
</head>
<body>
<main>
<form id="flow-ask">
${fragment}
${note}
<div class="flow-bar"><button type="submit">Send</button><span id="flow-status"></span></div>
</form>
</main>
<script>
(() => {
  const form = document.getElementById("flow-ask"), status = document.getElementById("flow-status"), send = form.querySelector("button[type=submit]");
  const say = (t) => { status.textContent = t; };
  const collect = () => {
    const o = { choice: [] };
    for (const el of form.elements) {
      if (!el.name || el.disabled || el.type === "submit" || el.type === "button") continue;
      if ((el.type === "checkbox" || el.type === "radio") && !el.checked) continue;
      if (el.name === "choice") { o.choice.push(el.value); continue; }
      if (el.type === "checkbox") { (o[el.name] = o[el.name] || []).push(el.value); continue; }
      o[el.name] = o[el.name] === undefined ? el.value : [].concat(o[el.name], el.value);
    }
    return o;
  };
  const fill = (o) => {
    for (const el of form.elements) {
      if (!el.name || !(el.name in o)) continue;
      const v = o[el.name];
      if (el.type === "checkbox" || el.type === "radio") el.checked = Array.isArray(v) ? v.includes(el.value) : v === el.value;
      else if (el.type !== "submit" && el.type !== "button") el.value = Array.isArray(v) ? v[0] : v;
    }
  };
  const close = () => { for (const el of form.elements) el.disabled = true; say("This question is closed: the run has moved on."); };
  const post = (path, o) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(o) });
  let open = true, timer;
  fetch("answer", { cache: "no-store" }).then((r) => r.json()).then((s) => {
    if (s.draft || s.answer) fill(s.draft || s.answer);
    if (!s.open) return close();
    say(s.draft ? "Draft restored, not sent yet." : s.answer ? "Sent ✓ You can change it and send again." : "");
  }).catch(() => say("Could not load the saved state."));
  form.addEventListener("input", () => {
    if (!open) return;
    clearTimeout(timer);
    timer = setTimeout(() => post("draft", collect()).then((r) => { if (r.status === 410) { open = false; close(); } else if (r.ok) say("Draft saved, not sent yet."); }).catch(() => {}), 600);
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    clearTimeout(timer);
    send.disabled = true;
    post("answer", collect()).then(async (r) => {
      if (r.status === 410) { open = false; return close(); }
      send.disabled = false;
      say(r.ok ? "Sent ✓" : "Not sent: " + ((await r.json().catch(() => ({}))).error || r.status));
    }).catch(() => { send.disabled = false; say("Not sent: no connection. Try again."); });
  });
})();
</script>
</body>
</html>
`;
}

/** The page's JSON as an answer, or why it is not one. */
export function parseAnswer(body: unknown): Answer | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "an answer is a JSON object" };
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === "string")) out[k] = v as string[];
    else return { error: `${k}: a string or a list of strings` };
  }
  const choice = out.choice;
  return { ...out, choice: choice === undefined ? [] : typeof choice === "string" ? [choice] : choice } as Answer;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
