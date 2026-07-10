import { NextRequest, NextResponse } from 'next/server';
import { API_BACKEND_URL } from '@/lib/api-config';

type RouteContext = { params: { path: string[] } };

async function proxy(req: NextRequest, { params }: RouteContext) {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ success: false, message: 'Not found' }, { status: 404 });
  }

  const path = params.path.join('/');
  const target = `${API_BACKEND_URL.replace(/\/$/, '')}/${path}${req.nextUrl.search}`;

  const headers: HeadersInit = {};
  const auth = req.headers.get('authorization');
  if (auth) headers['Authorization'] = auth;

  const contentType = req.headers.get('content-type');
  if (contentType) headers['Content-Type'] = contentType;

  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : await req.arrayBuffer(),
  });

  const body = await upstream.text();
  return new NextResponse(body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
    },
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const DELETE = proxy;
export const PATCH = proxy;
