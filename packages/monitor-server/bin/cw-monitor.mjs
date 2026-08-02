#!/usr/bin/env node
import { mainMonitor } from '../dist/index.js';

await mainMonitor(process.argv.slice(2));
