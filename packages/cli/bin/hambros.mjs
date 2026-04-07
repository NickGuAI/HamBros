#!/usr/bin/env node
import { runCli } from '../dist/index.js'

process.exitCode = await runCli(process.argv.slice(2))
