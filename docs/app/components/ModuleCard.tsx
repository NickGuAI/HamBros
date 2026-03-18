import Link from 'next/link'

interface ModuleCardProps {
  title: string
  description: string
  href: string
  icon: string
}

export function ModuleCard({ title, description, href, icon }: ModuleCardProps) {
  return (
    <Link href={href} className="block group">
      <div className="card-sumi p-6 h-full">
        <div className="text-2xl mb-3">{icon}</div>
        <h3 className="font-display text-heading text-sumi-black mb-2 group-hover:text-accent-indigo transition-colors">
          {title}
        </h3>
        <p className="text-sm text-sumi-diluted leading-relaxed">{description}</p>
      </div>
    </Link>
  )
}
