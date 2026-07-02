import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";

const PRIME = 257n;

function mod(value) {
  const normalized = value % PRIME;
  return normalized >= 0n ? normalized : normalized + PRIME;
}

function modInverse(value) {
  let t = 0n;
  let newT = 1n;
  let r = PRIME;
  let newR = mod(value);

  while (newR !== 0n) {
    const quotient = r / newR;
    [t, newT] = [newT, t - quotient * newT];
    [r, newR] = [newR, r - quotient * newR];
  }

  if (r !== 1n) {
    throw new Error("value has no inverse in the Shamir field");
  }

  return mod(t);
}

function randomFieldElement() {
  const limit = 65535 - (65535 % Number(PRIME));
  for (;;) {
    const value = randomBytes(2).readUInt16BE(0);
    if (value < limit) {
      return BigInt(value % Number(PRIME));
    }
  }
}

function evaluatePolynomial(coefficients, x) {
  let acc = 0n;
  for (let index = coefficients.length - 1; index >= 0; index -= 1) {
    acc = mod(acc * x + coefficients[index]);
  }
  return acc;
}

function interpolateAtZero(points) {
  let secret = 0n;

  for (let index = 0; index < points.length; index += 1) {
    const { x, y } = points[index];
    let numerator = 1n;
    let denominator = 1n;

    for (let otherIndex = 0; otherIndex < points.length; otherIndex += 1) {
      if (otherIndex === index) {
        continue;
      }

      const otherX = points[otherIndex].x;
      numerator = mod(numerator * -otherX);
      denominator = mod(denominator * (x - otherX));
    }

    secret = mod(secret + y * numerator * modInverse(denominator));
  }

  return secret;
}

export function splitSecretString(secret, { threshold = 3, shareCount = 5 } = {}) {
  if (threshold < 2) {
    throw new Error("threshold must be at least 2");
  }

  if (shareCount < threshold) {
    throw new Error("shareCount must be greater than or equal to threshold");
  }

  const bytes = Buffer.from(secret, "utf8");
  const shares = Array.from({ length: shareCount }, (_unused, shareIndex) => ({
    x: shareIndex + 1,
    values: [],
  }));

  for (const byte of bytes) {
    const coefficients = [BigInt(byte), ...Array.from({ length: threshold - 1 }, () => randomFieldElement())];
    for (const share of shares) {
      share.values.push(Number(evaluatePolynomial(coefficients, BigInt(share.x))));
    }
  }

  return shares;
}

export function reconstructSecretString(shares) {
  if (!Array.isArray(shares) || shares.length < 3) {
    throw new Error("at least 3 Shamir shares are required");
  }

  const normalized = shares.map((share) => {
    if (typeof share?.x !== "number" || !Array.isArray(share?.values)) {
      throw new Error("invalid Shamir share");
    }

    return {
      x: BigInt(share.x),
      values: share.values.map((value) => BigInt(value)),
    };
  });

  const length = normalized[0].values.length;
  if (normalized.some((share) => share.values.length !== length)) {
    throw new Error("Shamir shares must have the same length");
  }

  const bytes = [];
  for (let byteIndex = 0; byteIndex < length; byteIndex += 1) {
    const points = normalized.map((share) => ({
      x: share.x,
      y: mod(share.values[byteIndex]),
    }));
    bytes.push(Number(interpolateAtZero(points)));
  }

  return Buffer.from(bytes).toString("utf8");
}
