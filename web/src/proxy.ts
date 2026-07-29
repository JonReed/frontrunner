import { NextResponse } from 'next/server';

/**
 * The inherited web application is retained only as upstream reference code.
 *
 * It contains tool-capable agent, browser-driving and direct process endpoints
 * that predate Frontrunner's hostile-content and application-service
 * boundaries. Fail every runtime request closed even if somebody bypasses the
 * package scripts and invokes Next directly.
 */
export function proxy() {
  return new NextResponse(
    'This inherited interface is archived. Start the Frontrunner UI instead.',
    {
      status: 410,
      headers: {
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
        'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
        'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
      },
    },
  );
}

export const config = {
  matcher: '/:path*',
};
