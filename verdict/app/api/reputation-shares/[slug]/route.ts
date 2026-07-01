import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PROFILE_BACKEND_URL = process.env.PROFILE_BACKEND_URL ?? "http://127.0.0.1:4001";

function backendUrl(path: string) {
  return `${PROFILE_BACKEND_URL.replace(/\/$/, "")}${path}`;
}

export async function GET(_request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;

  try {
    const response = await fetch(backendUrl(`/reputation-shares/${encodeURIComponent(slug)}`), {
      method: "GET",
      cache: "no-store",
    });

    const payload = await response.json().catch(() => null);
    return NextResponse.json(payload ?? { share: null }, { status: response.status });
  } catch {
    return NextResponse.json({ error: "Profile service unavailable" }, { status: 503 });
  }
}
