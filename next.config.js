/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_API_URL:
      process.env.NEXT_PUBLIC_API_URL ||
      (process.env.NODE_ENV === 'development'
        ? '/api/proxy/v1'
        : 'https://nautilus.crafttechhub.com/api/v1'),
  },
}

module.exports = nextConfig
