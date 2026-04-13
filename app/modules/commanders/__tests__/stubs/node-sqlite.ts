type MemoryDoc = {
  hash: string
  corpus: string
}

type Statement = {
  all: (...args: unknown[]) => unknown[]
  run: (...args: unknown[]) => void
}

const docsByPath = new Map<string, Map<string, MemoryDoc>>()

function getDocs(dbPath: string): Map<string, MemoryDoc> {
  let docs = docsByPath.get(dbPath)
  if (!docs) {
    docs = new Map()
    docsByPath.set(dbPath, docs)
  }
  return docs
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .match(/[a-z0-9._/-]+/g) ?? []
}

export class DatabaseSync {
  private readonly dbPath: string

  constructor(dbPath: string) {
    this.dbPath = dbPath
  }

  exec(_sql: string): void {}

  prepare(sql: string): Statement {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()
    const docs = getDocs(this.dbPath)

    if (normalized.startsWith('select id, hash from memory_docs')) {
      return {
        all: () => [...docs.entries()].map(([id, doc]) => ({ id, hash: doc.hash })),
        run: () => {},
      }
    }

    if (normalized.startsWith('delete from memory_docs where id = ?')) {
      return {
        all: () => [],
        run: (id: unknown) => {
          if (typeof id === 'string') {
            docs.delete(id)
          }
        },
      }
    }

    if (normalized.startsWith('delete from memory_docs_fts where id = ?')) {
      return {
        all: () => [],
        run: () => {},
      }
    }

    if (normalized.includes('insert into memory_docs (id, hash, corpus)')) {
      return {
        all: () => [],
        run: (id: unknown, hash: unknown, corpus: unknown) => {
          if (typeof id === 'string' && typeof hash === 'string' && typeof corpus === 'string') {
            docs.set(id, { hash, corpus })
          }
        },
      }
    }

    if (normalized.startsWith('insert into memory_docs_fts')) {
      return {
        all: () => [],
        run: () => {},
      }
    }

    if (normalized.includes('select id, bm25(memory_docs_fts) as rank')) {
      return {
        all: (query: unknown, limit: unknown) => {
          if (typeof query !== 'string') {
            return []
          }
          const terms = tokenize(query)
          const maxResults = typeof limit === 'number' && Number.isFinite(limit)
            ? Math.max(1, Math.floor(limit))
            : 1

          return [...docs.entries()]
            .map(([id, doc]) => {
              const lowerCorpus = doc.corpus.toLowerCase()
              const matches = terms.reduce((count, term) => (
                lowerCorpus.includes(term.replaceAll('*', '')) ? count + 1 : count
              ), 0)
              return { id, rank: matches > 0 ? -matches : 0 }
            })
            .filter((row) => row.rank < 0)
            .sort((left, right) => left.rank - right.rank)
            .slice(0, maxResults)
        },
        run: () => {},
      }
    }

    return {
      all: () => [],
      run: () => {},
    }
  }

  close(): void {}
}
