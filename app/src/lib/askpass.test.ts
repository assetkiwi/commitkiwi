import { test } from "node:test";
import assert from "node:assert/strict";
import { isConfirmPrompt, isSecretPrompt } from "./askpass.ts";

test("askpass prompts: hidden for secrets, plain for names and yes/no", () => {
  for (const p of ["Password for 'https://bob@github.com': ", "Enter passphrase for key '/home/x/.ssh/id_ed25519': ", "Enter PIN for ECDSA-SK key: ", "bob@host's password: "]) assert.ok(isSecretPrompt(p), p);
  for (const p of ["Username for 'https://github.com': ", "Are you sure you want to continue connecting (yes/no/[fingerprint])? "]) assert.ok(!isSecretPrompt(p), p);
  assert.ok(isConfirmPrompt("The authenticity of host 'x' can't be established.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? "));
  assert.ok(!isConfirmPrompt("Username for 'https://github.com': "));
});
