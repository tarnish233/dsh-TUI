#!/usr/bin/env node
// Native Node strips the project's erasable TypeScript sources.
import { main } from '../src/cli.ts'
await main(process.argv.slice(2))
