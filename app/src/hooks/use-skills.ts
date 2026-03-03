import { useQuery } from '@tanstack/react-query'
import { fetchJson } from '@/lib/api'

export interface Skill {
  name: string
  description: string
  userInvocable: boolean
  argumentHint?: string
}

async function fetchSkills(): Promise<Skill[]> {
  return fetchJson<Skill[]>('/api/agents/skills')
}

export function useSkills() {
  return useQuery({
    queryKey: ['agents', 'skills'],
    queryFn: fetchSkills,
    staleTime: 60_000,
  })
}
