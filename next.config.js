/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    instrumentationHook: true,   // enables instrumentation.js for server-side background workers
  },
};

module.exports = nextConfig;
