import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

const testDirectories: string[] = []

function resolveLaunchHelpersPath(): string {
  const candidates = [
    path.resolve(process.cwd(), 'operations/scripts/_launch_helpers.sh'),
    path.resolve(process.cwd(), '../../operations/scripts/_launch_helpers.sh'),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  throw new Error('Unable to locate operations/scripts/_launch_helpers.sh')
}

async function runBashScript(
  scriptPath: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile('bash', [scriptPath], { env }, (error, stdout, stderr) => {
      if (error) {
        reject(
          new Error(
            `Failed running ${scriptPath}: ${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        )
        return
      }

      resolve(stdout.toString())
    })
  })
}

afterEach(async () => {
  await Promise.all(
    testDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe('launch helpers', () => {
  it('re-execs launch scripts with a hermetic env before service-owned env loading', async () => {
    const helpersPath = resolveLaunchHelpersPath()
    const tempDir = await mkdtemp(path.join(tmpdir(), 'launch-helper-test-'))
    testDirectories.push(tempDir)

    const envFilePath = path.join(tempDir, '.env')
    await writeFile(
      envFilePath,
      ['AUTH0_DOMAIN=service-auth0.example', 'DATABASE_URL=postgres://service-db'].join('\n'),
      'utf8',
    )

    const launchScriptPath = path.join(tempDir, 'launch_probe.sh')
    await writeFile(
      launchScriptPath,
      [
        '#!/bin/bash',
        '',
        'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"',
        `source "${helpersPath}"`,
        'ensure_hermetic_launch_env "$@"',
        '',
        'set -a',
        'source "$SCRIPT_DIR/.env"',
        'set +a',
        '',
        'echo "AUTH0_DOMAIN=${AUTH0_DOMAIN:-}"',
        'echo "DATABASE_URL=${DATABASE_URL:-}"',
        'echo "VITE_AUTH0_DOMAIN=${VITE_AUTH0_DOMAIN:-}"',
        'echo "PARENT_ONLY=${PARENT_ONLY:-}"',
        'echo "LAUNCH_HERMETIC_ENV=${LAUNCH_HERMETIC_ENV:-}"',
      ].join('\n'),
      'utf8',
    )
    await chmod(launchScriptPath, 0o755)

    const output = await runBashScript(launchScriptPath, {
      ...process.env,
      HOME: process.env.HOME ?? tempDir,
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      USER: process.env.USER ?? 'hammurabi',
      SHELL: process.env.SHELL ?? '/bin/bash',
      AUTH0_DOMAIN: 'hammurabi.example',
      VITE_AUTH0_DOMAIN: 'hammurabi-vite.example',
      DATABASE_URL: 'postgres://hammurabi-db',
      PARENT_ONLY: 'should-not-leak',
    })

    const values = Object.fromEntries(
      output
        .trim()
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => {
          const [key, value = ''] = line.split('=', 2)
          return [key, value]
        }),
    )

    expect(values.AUTH0_DOMAIN).toBe('service-auth0.example')
    expect(values.DATABASE_URL).toBe('postgres://service-db')
    expect(values.VITE_AUTH0_DOMAIN).toBe('')
    expect(values.PARENT_ONLY).toBe('')
    expect(values.LAUNCH_HERMETIC_ENV).toBe('1')
  })

  it('applies hermetic launch re-exec to every launch_*.sh script', async () => {
    const helpersPath = resolveLaunchHelpersPath()
    const scriptsDir = path.dirname(helpersPath)
    const scriptNames = (await readdir(scriptsDir)).filter((name) =>
      /^launch_[\w-]+\.sh$/.test(name),
    )

    for (const scriptName of scriptNames) {
      const scriptPath = path.join(scriptsDir, scriptName)
      const scriptContents = await readFile(scriptPath, 'utf8')
      expect(scriptContents).toContain('ensure_hermetic_launch_env "$@"')
    }
  })
})
