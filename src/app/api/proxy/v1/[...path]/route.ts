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
      { success: false, message: 'Dev API proxy unavailable. Restart npm run dev.' },
      { status: 502 }
    );
  }
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const DELETE = proxy;
export const PATCH = proxy;
