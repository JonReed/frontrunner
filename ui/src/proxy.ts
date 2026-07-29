import { randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

export const UI_HOSTS = new Set([
  '127.0.0.1:3100',
  'localhost:3100',
]);
export const UI_ORIGINS = new Set([
  'http://127.0.0.1:3100',
  'http://localhost:3100',
]);

export function proxy(request: NextRequest) {
  if (!UI_HOSTS.has(request.headers.get('host')?.toLowerCase() ?? '')) {
    return new NextResponse('Frontrunner is local-only', { status: 403 });
  }
  const origin = request.headers.get('origin');
  if (origin && !UI_ORIGINS.has(origin.toLowerCase())) {
    return new NextResponse('Cross-origin request denied', { status: 403 });
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
  response.headers.set('cross-origin-opener-policy', 'same-origin');
  response.headers.set('cross-origin-resource-policy', 'same-origin');
  response.headers.set('referrer-policy', 'no-referrer');
  response.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  response.headers.set('cache-control', 'no-store');
  return response;
}

export const config = {
  // Keep the local-only boundary in front of every asset and framework route,
  // not only application pages and actions.
  matcher: ['/:path*'],
};
