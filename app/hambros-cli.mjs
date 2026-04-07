#!/usr/bin/env node
import { runCli } from '@hambros/cli'

process.exitCode = await runCli(process.argv.slice(2))
