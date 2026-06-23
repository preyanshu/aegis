import dotenv from 'dotenv';

export function loadEnv({ preserve = [] } = {}) {
  const runtimeValues = new Map(
    preserve
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );

  dotenv.config({ override: true });

  for (const [key, value] of runtimeValues) {
    process.env[key] = value;
  }
}
