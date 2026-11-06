#!/usr/bin/env node
// Compatibility alias; the native DSH profile owns the production application.
import { main } from '../lib/cli.js'
await main(process.argv.slice(2))
