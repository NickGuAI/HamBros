import { runCommanderCli } from './commander.js'
import { runCronCli } from './cron.js'
import { runInitCli } from './init.js'
import { runMemoryCli } from './memory.js'
import { runCli as runOnboardCli } from './onboard.js'
import { runQuestsCli } from './quests.js'
import { runStartCli } from './start.js'
import { runWorkersCli } from './workers.js'

function printUsage(): void {
  process.stdout.write('Usage:\n')
  process.stdout.write('  hambros init\n')
  process.stdout.write('  hambros start\n')
  process.stdout.write('  hambros onboard\n')
  process.stdout.write('  hambros quests <command>\n')
  process.stdout.write('  hambros workers <command>\n')
  process.stdout.write('  hambros cron <command>\n')
  process.stdout.write('  hambros commander <command>\n')
  process.stdout.write('  hambros memory <command>\n')
}

export async function runCli(args: readonly string[]): Promise<number> {
  const command = args[0]

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printUsage()
    return 0
  }

  if (command === 'init') {
    return runInitCli(args.slice(1))
  }
  if (command === 'start') {
    return runStartCli(args.slice(1))
  }
  if (command === 'onboard') {
    return runOnboardCli(args.slice(1))
  }
  if (command === 'quests') {
    return runQuestsCli(args.slice(1))
  }
  if (command === 'workers') {
    return runWorkersCli(args.slice(1))
  }
  if (command === 'cron') {
    return runCronCli(args.slice(1))
  }
  if (command === 'commander') {
    return runCommanderCli(args.slice(1))
  }
  if (command === 'memory') {
    return runMemoryCli(args.slice(1))
  }

  printUsage()
  return 1
}
