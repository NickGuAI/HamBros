interface ApiEndpointProps {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  description: string
  children?: React.ReactNode
}

const methodColors: Record<string, string> = {
  GET: 'bg-accent-moss/15 text-accent-moss',
  POST: 'bg-accent-indigo/15 text-accent-indigo',
  PUT: 'bg-accent-persimmon/15 text-accent-persimmon',
  PATCH: 'bg-accent-persimmon/15 text-accent-persimmon',
  DELETE: 'bg-accent-vermillion/15 text-accent-vermillion',
}

export function ApiEndpoint({ method, path, description, children }: ApiEndpointProps) {
  return (
    <div className="card-sumi my-4 overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-3 border-b border-ink-border bg-ink-wash">
        <span className={`inline-flex items-center px-2.5 py-0.5 text-xs font-mono font-medium uppercase rounded ${methodColors[method]}`}>
          {method}
        </span>
        <code className="font-mono text-sm text-sumi-black">{path}</code>
      </div>
      <div className="px-5 py-3">
        <p className="text-sm text-sumi-gray">{description}</p>
        {children && <div className="mt-3">{children}</div>}
      </div>
    </div>
  )
}
