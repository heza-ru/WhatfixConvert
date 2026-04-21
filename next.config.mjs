/** @type {import('next').NextConfig} */
const nextConfig = {
  compress: true,
  poweredByHeader: false,
  productionBrowserSourceMaps: false,

  // Turbopack (default in Next.js 16): alias canvas away from the browser bundle
  turbopack: {
    resolveAlias: {
      canvas: { browser: './lib/canvas-stub.js' },
    },
  },

  // Strict security headers on every response
  async headers() {
    const isDev = process.env.NODE_ENV !== 'production';

    // 'unsafe-eval' is required by React in dev mode (callstack reconstruction).
    // React explicitly does NOT use eval() in production builds.
    const scriptSrc = isDev
      ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
      : "script-src 'self' 'unsafe-inline'";

    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options',    value: 'nosniff' },
          { key: 'X-Frame-Options',           value: 'DENY' },
          { key: 'X-XSS-Protection',          value: '1; mode=block' },
          { key: 'Referrer-Policy',           value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy',        value: 'camera=(), microphone=(), geolocation=()' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              scriptSrc,
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "font-src 'self' data: https://fonts.gstatic.com",
              "img-src 'self' data: blob: https://cdn.brandfetch.io",
              "frame-src 'self' blob:",               // blob: needed for preview iframe (blob URL)
              "connect-src 'self'",                   // API calls go to same origin only
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
