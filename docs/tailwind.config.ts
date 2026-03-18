import type { Config } from 'tailwindcss'
import typography from '@tailwindcss/typography'

export default {
  content: ['./app/**/*.{ts,tsx,md,mdx}'],
  theme: {
    extend: {
      colors: {
        sumi: {
          black: '#1C1C1C',
          gray: '#4A4A4A',
          diluted: '#8B8B8B',
          mist: '#C4C4C4',
          stone: '#A8A19A',
        },
        washi: {
          white: '#FAF8F5',
          aged: '#F0EBE3',
          shadow: '#E8E4DC',
        },
        accent: {
          vermillion: '#C23B22',
          moss: '#6B7B5E',
          persimmon: '#D4763A',
          indigo: '#4A5899',
        },
        ink: {
          wash: 'rgba(28, 28, 28, 0.03)',
          border: 'rgba(28, 28, 28, 0.06)',
          'border-hover': 'rgba(28, 28, 28, 0.12)',
          focus: 'rgba(28, 28, 28, 0.04)',
        },
      },
      fontFamily: {
        display: ['Cormorant Garamond', 'Hiragino Mincho Pro', 'serif'],
        body: ['Source Sans 3', '-apple-system', 'Hiragino Kaku Gothic Pro', 'sans-serif'],
        mono: ['JetBrains Mono', 'SF Mono', 'monospace'],
      },
      fontSize: {
        display: ['2rem', { lineHeight: '1.2', fontWeight: '300' }],
        heading: ['1.375rem', { lineHeight: '1.3', fontWeight: '400' }],
        section: ['0.875rem', { lineHeight: '1.4', fontWeight: '500', letterSpacing: '0.12em' }],
        whisper: ['0.6875rem', { lineHeight: '1.4', letterSpacing: '0.08em' }],
      },
      borderRadius: {
        organic: '4px 20px 4px 20px',
        'organic-sm': '2px 12px 2px 12px',
        'organic-lg': '4px 24px 4px 24px',
      },
      boxShadow: {
        'ink-sm': '0 2px 4px rgba(28, 28, 28, 0.02), 0 12px 40px rgba(28, 28, 28, 0.03)',
        'ink-md': '0 4px 20px rgba(28, 28, 28, 0.04)',
        'ink-lg': '0 8px 32px rgba(28, 28, 28, 0.06)',
        'ink-hover': '0 4px 20px rgba(28, 28, 28, 0.08)',
      },
      transitionTimingFunction: {
        'out-expo': 'cubic-bezier(0.19, 1, 0.22, 1)',
        gentle: 'cubic-bezier(0.23, 1, 0.32, 1)',
      },
      keyframes: {
        breathe: {
          '0%, 100%': { opacity: '0.4', transform: 'scale(1)' },
          '50%': { opacity: '1', transform: 'scale(1.02)' },
        },
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        breathe: 'breathe 2.5s ease-in-out infinite',
        'fade-in': 'fade-in 0.5s cubic-bezier(0.23, 1, 0.32, 1) forwards',
      },
      lineHeight: {
        relaxed: '1.7',
        airy: '1.8',
      },
      typography: {
        sumi: {
          css: {
            '--tw-prose-body': '#4A4A4A',
            '--tw-prose-headings': '#1C1C1C',
            '--tw-prose-lead': '#4A4A4A',
            '--tw-prose-links': '#4A5899',
            '--tw-prose-bold': '#1C1C1C',
            '--tw-prose-counters': '#8B8B8B',
            '--tw-prose-bullets': '#C4C4C4',
            '--tw-prose-hr': 'rgba(28, 28, 28, 0.06)',
            '--tw-prose-quotes': '#4A4A4A',
            '--tw-prose-quote-borders': 'rgba(28, 28, 28, 0.06)',
            '--tw-prose-captions': '#8B8B8B',
            '--tw-prose-code': '#C23B22',
            '--tw-prose-pre-code': '#FAF8F5',
            '--tw-prose-pre-bg': '#1C1C1C',
            '--tw-prose-th-borders': 'rgba(28, 28, 28, 0.12)',
            '--tw-prose-td-borders': 'rgba(28, 28, 28, 0.06)',
            'h1, h2, h3, h4': {
              fontFamily: 'Cormorant Garamond, Hiragino Mincho Pro, serif',
            },
            a: {
              textDecoration: 'none',
              borderBottom: '1px solid rgba(74, 88, 153, 0.3)',
              transition: 'border-color 0.2s',
              '&:hover': {
                borderColor: '#4A5899',
              },
            },
            code: {
              fontFamily: 'JetBrains Mono, SF Mono, monospace',
              fontSize: '0.875em',
              fontWeight: '400',
              padding: '2px 6px',
              borderRadius: '4px',
              backgroundColor: 'rgba(28, 28, 28, 0.04)',
            },
            'code::before': { content: '""' },
            'code::after': { content: '""' },
            pre: {
              borderRadius: '4px 20px 4px 20px',
              border: '1px solid rgba(28, 28, 28, 0.06)',
            },
            'pre code': {
              backgroundColor: 'transparent',
              padding: '0',
            },
            table: {
              borderRadius: '4px',
              overflow: 'hidden',
            },
            th: {
              fontWeight: '500',
              textTransform: 'uppercase',
              fontSize: '0.75rem',
              letterSpacing: '0.08em',
              color: '#8B8B8B',
            },
          },
        },
      },
    },
  },
  plugins: [typography],
} satisfies Config
