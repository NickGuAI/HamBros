interface CodeBlockProps {
  children: string
  language?: string
  title?: string
}

export function CodeBlock({ children, language = 'bash', title }: CodeBlockProps) {
  return (
    <div className="my-4">
      {title && (
        <div className="bg-sumi-black text-sumi-mist text-whisper uppercase tracking-widest px-4 py-2 rounded-t-organic-sm border border-b-0 border-ink-border font-mono">
          {title}
        </div>
      )}
      <pre className={`bg-sumi-black text-washi-white p-4 overflow-x-auto font-mono text-sm leading-relaxed ${title ? 'rounded-b-organic' : 'rounded-organic'} border border-ink-border`}>
        <code className={`language-${language}`}>{children}</code>
      </pre>
    </div>
  )
}
