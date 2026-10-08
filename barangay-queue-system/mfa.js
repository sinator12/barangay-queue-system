const crypto = require("node:crypto");

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const MFA_ISSUER = "Barangay Queue System";

function encodeBase32(buffer) {
  let accumulator = 0;
  let bits = 0;
  let output = "";

  for (const byte of buffer) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET[(accumulator >> bits) & 31];
      accumulator &= (1 << bits) - 1;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(accumulator << (5 - bits)) & 31];
  }

  return output;
}

function decodeBase32(value) {
  let accumulator = 0;
  let bits = 0;
  const bytes = [];

  for (const character of value.toUpperCase().replace(/=+$/g, "")) {
    const index = BASE32_ALPHABET.indexOf(character);

    if (index < 0) {
      throw new Error("Invalid authenticator secret.");
    }

    accumulator = (accumulator << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 255);
      accumulator &= (1 << bits) - 1;
    }
  }

  return Buffer.from(bytes);
}

function createTotpSecret() {
  return encodeBase32(crypto.randomBytes(20));
}

function createOtpAuthUri(username, secret) {
  const label = `${MFA_ISSUER}:${username}`;
  const query = new URLSearchParams({
    secret,
    issuer: MFA_ISSUER,
    algorithm: "SHA1",
    digits: "6",
    period: "30"
  });

  return `otpauth://totp/${encodeURIComponent(label)}?${query.toString()}`;
}

function getTotpAt(secret, timestamp = Date.now()) {
  const counter = BigInt(Math.floor(timestamp / 30_000));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const digest = crypto.createHmac("sha1", decodeBase32(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 15;
  const binary = ((digest[offset] & 127) << 24)
    | ((digest[offset + 1] & 255) << 16)
    | ((digest[offset + 2] & 255) << 8)
    | (digest[offset + 3] & 255);

  return String(binary % 1_000_000).padStart(6, "0");
}

function verifyTotp(secret, submittedCode, timestamp = Date.now()) {
  if (typeof submittedCode !== "string") {
    return false;
  }

  const code = submittedCode.replace(/\s/g, "");

  if (!/^\d{6}$/.test(code)) {
    return false;
  }

  const submitted = Buffer.from(code);

  for (const offset of [-30_000, 0, 30_000]) {
    const expected = Buffer.from(getTotpAt(secret, timestamp + offset));

    if (crypto.timingSafeEqual(submitted, expected)) {
      return true;
    }
  }

  return false;
}

function createRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => {
    const rawCode = encodeBase32(crypto.randomBytes(10));
    return rawCode.match(/.{1,4}/g).join("-");
  });
}

function normalizeRecoveryCode(code) {
  return typeof code === "string" ? code.toUpperCase().replace(/[\s-]/g, "") : "";
}

function hashRecoveryCode(code) {
  return crypto.createHash("sha256").update(normalizeRecoveryCode(code)).digest("hex");
}

module.exports = {
  createOtpAuthUri,
  createRecoveryCodes,
  createTotpSecret,
  hashRecoveryCode,
  verifyTotp
};
