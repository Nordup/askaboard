import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // The repo has other lockfiles; this folder is the app's own root.
  turbopack: { root: __dirname }
}

export default nextConfig
