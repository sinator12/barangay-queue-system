const test = require("node:test");
const assert = require("node:assert/strict");
const { createRecoveryCodes, createTotpSecret, hashRecoveryCode, verifyTotp } = require("../mfa");

test("TOTP matches the RFC 6238 SHA-1 six-digit example", () => {
  const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(verifyTotp(rfcSecret, "287082", 59_000), true);
  assert.equal(verifyTotp(rfcSecret, "000000", 59_000), false);
});

test("new authenticator secrets are random, valid Base32 values", () => {
  const firstSecret = createTotpSecret();
  const secondSecret = createTotpSecret();
  assert.match(firstSecret, /^[A-Z2-7]{32}$/);
  assert.notEqual(firstSecret, secondSecret);
});

test("recovery codes are unique, printable once, and hashed independent of separators", () => {
  const codes = createRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, codes.length);
  assert.match(codes[0], /^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
  assert.equal(hashRecoveryCode(codes[0]), hashRecoveryCode(codes[0].replaceAll("-", " ")));
});
