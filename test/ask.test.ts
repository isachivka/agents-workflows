import { test } from "node:test";
import assert from "node:assert/strict";
import { askPage, parseAnswer } from "../src/ask.ts";

test("parseAnswer takes the overlay's shape: choice always a list, other names a string or a list", () => {
  assert.deepEqual(parseAnswer({ choice: ["a", "b"], note: "hi" }), { choice: ["a", "b"], note: "hi" });
  assert.deepEqual(parseAnswer({ choice: "a" }), { choice: ["a"] });
  assert.deepEqual(parseAnswer({ note: "" }), { choice: [], note: "" });
  assert.deepEqual(parseAnswer({ n: 1 }), { error: "n: a string or a list of strings" });
  assert.deepEqual(parseAnswer([1]), { error: "an answer is a JSON object" });
});

test("askPage wraps the fragment in a form with Send, adds a note box only when the fragment has none, escapes the title", () => {
  const page = askPage('<input type="checkbox" name="choice" value="a">', "Pick <one>");
  assert.match(page, /<form id="flow-ask">\n<input type="checkbox" name="choice" value="a">/);
  assert.match(page, /<textarea name="note"/);
  assert.match(page, /<title>Pick &lt;one&gt;<\/title>/);
  assert.match(page, /<button type="submit">Send<\/button>/);
  assert.doesNotMatch(askPage('<textarea name="note"></textarea>', "t"), /placeholder="Anything to add/);
});
