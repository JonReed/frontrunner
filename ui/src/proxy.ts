import { randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

function localHostname(value: string | null) {
  if (!value) return false;
  const host = value.toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export function proxy(request: NextRequest) {
  if (!localHostname(request.headers.get('host'))) {
    return new NextResponse('Frontrunner is local-only', { status: 403 });
  }
  const origin = request.headers.get('origin');
  if (origin) {
    try {
      if (!localHostname(new URL(origin).hostname)) return new NextResponse('Cross-origin request denied', { status: 403 });
    } catch {
      return new NextResponse('Invalid Origin', { status: 403 });
    }
  }

  const nonce = randomBytes(16).toString('base64');
  const requestHeaders = new Headers(request.headers);
  const devEval = process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : '';
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'${devEval}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  requestHeaders.set('content-security-policy', csp);
  requestHeaders.set('x-nonce', nonce);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', csp);
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('x-frame-options', 'DENY');
  response.headers.set('referrer-policy', 'no-referrer');
  response.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  response.headers.set('cache-control', 'no-store');
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
