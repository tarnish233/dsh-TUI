#!/usr/bin/env node
// DSH TUI entry. The older dsh-pi-tui entry remains a source-path alias.
import { main } from '../src/cli.ts'
await main(process.argv.slice(2))
