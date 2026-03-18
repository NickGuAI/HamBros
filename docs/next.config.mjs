import createMDX from '@next/mdx'
import remarkGfm from 'remark-gfm'

const withMDX = createMDX({
  options: {
    remarkPlugins: [remarkGfm],
  },
})

/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: '/docs',
  pageExtensions: ['ts', 'tsx', 'md', 'mdx'],
  output: 'standalone',
}

export default withMDX(nextConfig)
