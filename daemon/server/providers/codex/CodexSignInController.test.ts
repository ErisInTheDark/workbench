/* Exports: none. Protect that a Codex device-code sign-in ends only on its own login's completion. */
import assert from "node:assert/strict";
import { test } from "node:test";
import CodexSignInController from "./CodexSignInController";

function controller() {
  const requests: { method: string; params: object }[] = [];
  const signIn = new CodexSignInController({
    request: async (method, params) => {
      requests.push({ method, params });
      return method === "account/login/start"
        ? { type: "chatgptDeviceCode", loginId: "login-1", verificationUrl: "https://auth.example/device", userCode: "ABCD-1234" }
        : {};
    },
    readAccount: async () => null,
  });
  return { signIn, requests };
}

const completed = (loginId: string, success: boolean, error: string | null = null) => ({
  method: "account/login/completed", params: { loginId, success, error },
});

test("only the matching login completion settles the attempt", async () => {
  const { signIn } = controller();
  const flow = await signIn.begin("openai", "chatgpt", new AbortController().signal);
  assert.equal(flow.userCode, "ABCD-1234");
  let settled = false;
  void flow.settled.then(() => { settled = true; });
  signIn.observe(completed("someone-else", true));
  await Promise.resolve();
  assert.equal(settled, false);
  signIn.observe(completed("login-1", true));
  await flow.settled;
});

test("a failed completion carries Codex's error, and cancel names the login", async () => {
  const { signIn, requests } = controller();
  const flow = await signIn.begin("openai", "chatgpt", new AbortController().signal);
  signIn.observe(completed("login-1", false, "device code expired"));
  await assert.rejects(flow.settled, /device code expired/u);
  await flow.cancel();
  assert.deepEqual(requests.at(-1), { method: "account/login/cancel", params: { loginId: "login-1" } });
});
