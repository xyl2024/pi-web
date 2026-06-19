import { NextResponse } from "next/server";
import { getDashboardStatus, ensureCleanup } from "@/lib/playwright-dashboard";

// Register process-exit hooks once on module load.
ensureCleanup();

export async function GET() {
  const status = await getDashboardStatus();
  return NextResponse.json(status);
}