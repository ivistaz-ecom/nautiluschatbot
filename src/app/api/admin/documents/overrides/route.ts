import { NextResponse } from 'next/server';
import { getDocumentOverrides } from '@/lib/document-overrides-store';

export const dynamic = 'force-dynamic';

/** Local title/category overrides when PHP/DB update is unavailable. */
export async function GET() {
  return NextResponse.json({ success: true, data: getDocumentOverrides() });
}
