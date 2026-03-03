#!/usr/bin/env node
import { runCli } from '../dist/onboard.js'

process.exitCode = await runCli(process.argv.slice(2))
