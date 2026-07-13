import { NextRequest, NextResponse } from 'next/server';
import { API_BACKEND_URL } from '@/lib/api-config';

type RouteContext = { params: { path: string[] } };

function isAllowedProxyRequest(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;

  const host = req.headers.get('host');
  if (!host) return false;

  try {
    const originHost = new URL(origin).host;
    return originHost === host;
  } catch {
    return false;
  }
}

async function proxy(req: NextRequest, { params }: RouteContext) {
  if (!isAllowedProxyRequest(req)) {
    return NextResponse.json({ success: false, message: 'Forbidden' }, { status: 403 });
  }

  const path = params.path.join('/');
  const target = `${API_BACKEND_URL.replace(/\/$/, '')}/${path}${req.nextUrl.search}`;

  const headers: HeadersInit = {};
  const auth = req.headers.get('authorization');
  if (auth) headers['Authorization'] = auth;

  const requestContentType = req.headers.get('content-type');
  if (requestContentType) headers['Content-Type'] = requestContentType;

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : await req.arrayBuffer(),
    });

    const contentType = upstream.headers.get('Content-Type') || 'application/json';
    const isBinary =
      /\/file(\?|$)/.test(path) ||
      contentType.includes('application/pdf') ||
      contentType.includes('application/octet-stream') ||
      contentType.includes('application/vnd.');

    const body = isBinary ? await upstream.arrayBuffer() : await upstream.text();

    const responseHeaders = new Headers();
    responseHeaders.set('Content-Type', contentType);
    const contentDisposition = upstream.headers.get('Content-Disposition');
    if (contentDisposition) responseHeaders.set('Content-Disposition', contentDisposition);

    return new NextResponse(body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch {
    return NextResponse.json(
      { success: false, message: 'API proxy unavailable. Check API_BACKEND_URL on the server.' },
      { status: 502 }
    );
  }
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const DELETE = proxy;
export const PATCH = proxy;
