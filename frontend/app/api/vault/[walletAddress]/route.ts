import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PROFILE_BACKEND_URL = process.env.PROFILE_BACKEND_URL ?? "http://127.0.0.1:4003";

function backendUrl(path: string) {
  return `${PROFILE_BACKEND_URL.replace(/\/$/, "")}${path}`;
}

export async function GET(_request: NextRequest, context: { params: Promise<{ walletAddress: string }> }) {
  const { walletAddress } = await context.params;

  try {
    const response = await fetch(backendUrl(`/vault/${encodeURIComponent(walletAddress)}`), {
      method: "GET",
      cache: "no-store",
    });

    const payload = await response.json().catch(() => null);
    return NextResponse.json(payload ?? { vault: null }, { status: response.status });
  } catch {
    return NextResponse.json({ error: "Profile service unavailable" }, { status: 503 });
  }
}
