/* Exports: none. Protect that the sign-in link is found in Claude's raw terminal output, and pasted codes reach its prompt. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PseudoTerminalProcess } from "../../lib/pseudo-terminal";
import ClaudeSignInController, { claudeSignInUrl } from "./ClaudeSignInController";

const URL = "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code"
  + "&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile"
  + "&code_challenge=PM2_9HXy4FJc02KycEi4fhc1hvl0FjrC8L-jiiIsmY0&code_challenge_method=S256&state=BYARKfFyimj3_adBEBTx3tqXk69XQy5AKLIpqWO4g60";

test("the authorize link is found among terminal escape sequences", () => {
  const output = `\u001b[?25l\u001b[2JOpening browser to sign in…\r\nIf the browser didn't open, visit: \u001b[34m${URL}\u001b[39m\r\nPaste code here if prompted > `;
  assert.equal(claudeSignInUrl(output), URL);
  assert.equal(claudeSignInUrl("Opening browser to sign in…"), null);
});

function terminal() {
  const listeners: ((text: string) => void)[] = [];
  const written: string[] = [];
  let exit!: (code: number) => void;
  const process: PseudoTerminalProcess = {
    onOutput: listener => { listeners.push(listener); },
    write: text => { written.push(text); },
    exited: new Promise(resolve => { exit = resolve; }),
    kill: () => exit(1),
  };
  return { process, written, emit: (text: string) => listeners.forEach(listener => listener(text)), exit: (code: number) => exit(code) };
}

test("a link split across output chunks starts the flow, and a pasted code finishes it", async () => {
  const fake = terminal();
  const controller = new ClaudeSignInController({ resolveExecutable: () => "claude", spawn: async () => fake.process });
  const starting = controller.begin("anthropic", "claudeai", new AbortController().signal);
  await Promise.resolve();
  fake.emit(`visit: ${URL.slice(0, 40)}`);
  fake.emit(`${URL.slice(40)}\r\nPaste code here if prompted > `);
  const flow = await starting;
  assert.equal(flow.url, URL);
  await flow.submitCode!("abc#state");
  assert.deepEqual(fake.written, ["abc#state\r"]);
  fake.exit(0);
  await flow.settled;
});

test("a failed login reports Claude's last line", async () => {
  const fake = terminal();
  const controller = new ClaudeSignInController({ resolveExecutable: () => "claude", spawn: async () => fake.process });
  const starting = controller.begin("anthropic", "console", new AbortController().signal);
  await Promise.resolve();
  fake.emit(`visit: ${URL}\r\n`);
  const flow = await starting;
  fake.emit("\u001b[31mInvalid code\u001b[39m\r\n");
  fake.exit(1);
  await assert.rejects(flow.settled, /Invalid code/u);
});
