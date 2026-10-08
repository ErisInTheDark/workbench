/*
 * No production exports. Protects stable pre-clone consent and destination parsing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import WorkbenchBootstrapPrompt from "./WorkbenchBootstrapPrompt.mjs";

test("plain bootstrap choices retry invalid input and default to the first option", async () => {
  const answers = ["nope", ""];
  const output: string[] = [];
  const prompt = new WorkbenchBootstrapPrompt({
    ask: async () => answers.shift()!,
    output: { write: (text: string) => output.push(text) },
  });
  assert.equal(await prompt.choose("Continue?", ["Yes", "No"]), "Yes");
  assert.match(output.join(""), /1 to 2/u);
});

test("bootstrap locations expand home and add the checkout directory once", async () => {
  const prompt = new WorkbenchBootstrapPrompt({
    ask: async () => "~/Programs",
    platform: "linux",
    cwd: "/work",
    home: "/home/user",
  });
  assert.equal(await prompt.location("Location", "/unused"), "/home/user/Programs/wb");
  assert.equal(prompt.destination("/opt/workbench"), "/opt/workbench");
});
