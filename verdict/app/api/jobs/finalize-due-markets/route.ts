import { NextResponse } from "next/server";

const PROFILE_BACKEND_URL = process.env.PROFILE_BACKEND_URL ?? "http://localhost:4001";

function backendUrl(path: string) {
  return `${PROFILE_BACKEND_URL.replace(/\/$/, "")}${path}`;
}

export async function POST() {
  try {
    const response = await fetch(backendUrl("/jobs/finalize-due-markets"), {
      method: "POST",
    });

    const payload = await response.json().catch(() => null);
    return NextResponse.json(payload ?? { error: "Job service unavailable" }, { status: response.status });
  } catch {
    return NextResponse.json({ error: "Job service unavailable" }, { status: 503 });
  }
}
