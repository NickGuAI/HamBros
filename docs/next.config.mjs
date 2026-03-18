import createMDX from '@next/mdx'
import remarkGfm from 'remark-gfm'

const withMDX = createMDX({
  options: {
    remarkPlugins: [remarkGfm],
  },
})

/** @type {import('next').NextConfig} */
const nextConfig = {
  async redirects() {
    return [
      {
        source: '/docs/docs',
        destination: '/docs',
        permanent: true,
      },
      {
        source: '/docs/docs/:path*',
        destination: '/docs/:path*',
        permanent: true,
      },
    ]
  },
  pageExtensions: ['ts', 'tsx', 'md', 'mdx'],
  output: 'standalone',
}

export default withMDX(nextConfig)
