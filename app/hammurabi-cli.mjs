#!/usr/bin/env node
import { runCli } from '@gehirn/hammurabi-cli'

process.exitCode = await runCli(process.argv.slice(2))
