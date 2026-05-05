/** @type {import('next').NextConfig} */
const nextConfig = {
  // WAJIB untuk Dockerfile multi-stage — menghasilkan folder .next/standalone
  output: 'standalone',

  // Izinkan fetch ke domain eksternal yang digunakan aplikasi
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'polymarket.com'       },
      { protocol: 'https', hostname: 'gamma-api.polymarket.com' },
      { protocol: 'https', hostname: 'clob.polymarket.com'  },
    ],
  },

  // Supaya tidak error saat build karena env var belum ada
  typescript:  { ignoreBuildErrors: false },
  eslint:      { ignoreDuringBuilds: true },

  // Header keamanan
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options',        value: 'DENY'              },
          { key: 'X-Content-Type-Options',  value: 'nosniff'           },
          { key: 'Referrer-Policy',         value: 'strict-origin-when-cross-origin' },
        ],
      },
    ]
  },
}

module.exports = nextConfig
