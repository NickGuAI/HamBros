import path from 'node:path'

export type ForbiddenRootReferenceScan = {
  appRoot: string
  filePath: string
  source: string
}

type ForbiddenRootRule = {
  pattern: RegExp
  label: string
  allowedDeclarations?: readonly {
    filePath: string
    pattern: RegExp
  }[]
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

// Keep the canonical source directory split so SOP-15's branding sanitizer
// cannot rewrite the detector that is meant to catch a missed path rewrite in
// the generated public artifact.
const sourceAppDirectory = ['hammu', 'rabi'].join('')
const publicAppDirectory = 'herd'
const guardedAppDirectories = [sourceAppDirectory, publicAppDirectory]

function isSamePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right)
}

function sourceWithoutAllowedDeclarations(
  source: string,
  filePath: string,
  declarations: ForbiddenRootRule['allowedDeclarations'] = [],
): string {
  let candidate = source
  for (const declaration of declarations) {
    if (isSamePath(filePath, declaration.filePath)) {
      // Deliberately replace one exact declaration only. A duplicate entry or
      // any operational reference elsewhere in the same file remains visible.
      candidate = candidate.replace(declaration.pattern, '')
    }
  }
  return candidate
}

export function findForbiddenRootReferenceLabels({
  appRoot,
  filePath,
  source,
}: ForbiddenRootReferenceScan): string[] {
  const publicArtifactGuardPath = path.join(
    appRoot,
    'public',
    'repo-root',
    'scripts',
    'check-public-artifact.sh',
  )
  const canonicalSchemaMigrationImports = [
    {
      filePath: path.join(appRoot, 'server', 'db', 'index.ts'),
      pattern: /from\s+['"][.]\/migrations[.]js['"]/u,
    },
    {
      filePath: path.join(appRoot, 'server', 'db', 'readiness.ts'),
      pattern: /from\s+['"][.]\/migrations[.]js['"]/u,
    },
    {
      filePath: path.join(appRoot, 'server', '__tests__', 'sqlite-readiness.test.ts'),
      pattern: /from\s+['"][.][.]\/db\/migrations[.]js['"]/u,
    },
  ] as const
  const rules: readonly ForbiddenRootRule[] = [
    {
      pattern: new RegExp(
        `apps/(?:${guardedAppDirectories.map(escapeRegExp).join('|')})/(?:scripts|migrations|agents)`,
        'u',
      ),
      label: 'retired app root path',
      // This guard must enumerate the public app-root agents path it rejects.
      // Allow only that one shell-list declaration; the rest of the file is
      // scanned for both public and missed canonical-source path rewrites.
      allowedDeclarations: [{
        filePath: publicArtifactGuardPath,
        pattern: new RegExp(
          `^\\s*"apps/${escapeRegExp(publicAppDirectory)}/agents"\\s*\\\\\\s*$`,
          'mu',
        ),
      }],
    },
    {
      pattern: /agents\/terminal_bench/u,
      label: 'retired app-root Terminal Bench path',
    },
    {
      pattern: /from\s+['"][^'"]*migrations/u,
      label: 'migration import',
      // Supported schema upgrades are owned by the canonical readiness module.
      // Keep every other runtime migration import visible so one-off legacy
      // conversion code cannot grow a second production rail.
      allowedDeclarations: canonicalSchemaMigrationImports,
    },
    {
      pattern: /\.\/scripts\//u,
      label: 'app scripts path dependency',
    },
  ]

  return rules
    .filter(({ pattern, allowedDeclarations }) => pattern.test(
      sourceWithoutAllowedDeclarations(source, filePath, allowedDeclarations),
    ))
    .map(({ label }) => label)
}
