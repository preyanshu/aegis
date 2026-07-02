import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function loadEnv({ preserve = [] } = {}) {
  const runtimeValues = new Map(
    preserve
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );

  const envFiles = [
    resolve(process.cwd(), "..", ".env"),
    resolve(process.cwd(), ".env"),
  ];

  for (const path of envFiles) {
    if (existsSync(path)) {
      dotenv.config({ path, override: true });
    }
  }

  for (const [key, value] of runtimeValues) {
    process.env[key] = value;
  }
}
