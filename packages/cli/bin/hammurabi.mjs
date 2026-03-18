#!/usr/bin/env node
import { runCli as runOnboardCli } from '../dist/onboard.js'
import { runQuestsCli } from '../dist/quests.js'
import { runWorkersCli } from '../dist/workers.js'
import { runCommanderCli } from '../dist/commander.js'
import { runCronCli } from '../dist/cron.js'
import { runMemoryCli } from '../dist/memory.js'

function printUsage() {
  process.stdout.write('Usage:\n')
  process.stdout.write('  hammurabi onboard\n')
  process.stdout.write('  hammurabi quests <command>\n')
  process.stdout.write('  hammurabi workers <command>\n')
  process.stdout.write('  hammurabi cron <command>\n')
  process.stdout.write('  hammurabi commander <command>\n')
  process.stdout.write('  hammurabi memory <command>\n')
}

const args = process.argv.slice(2)
const command = args[0]

if (!command || command === 'onboard') {
  process.exitCode = await runOnboardCli(command ? args : [])
} else if (command === 'quests') {
  process.exitCode = await runQuestsCli(args.slice(1))
} else if (command === 'workers') {
  process.exitCode = await runWorkersCli(args.slice(1))
} else if (command === 'cron') {
  process.exitCode = await runCronCli(args.slice(1))
} else if (command === 'commander') {
  process.exitCode = await runCommanderCli(args.slice(1))
} else if (command === 'memory') {
  process.exitCode = await runMemoryCli(args.slice(1))
} else {
  printUsage()
  process.exitCode = 1
}
