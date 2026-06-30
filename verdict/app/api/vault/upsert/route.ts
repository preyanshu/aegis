import { NextResponse } from "next/server";

const PROFILE_BACKEND_URL = process.env.PROFILE_BACKEND_URL ?? "http://localhost:4001";

function backendUrl(path: string) {
  return `${PROFILE_BACKEND_URL.replace(/\/$/, "")}${path}`;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const response = await fetch(backendUrl("/vault/upsert"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const payload = await response.json().catch(() => null);
    return NextResponse.json(payload ?? { error: "Profile service unavailable" }, { status: response.status });
  } catch {
    return NextResponse.json({ error: "Profile service unavailable" }, { status: 503 });
  }
}
