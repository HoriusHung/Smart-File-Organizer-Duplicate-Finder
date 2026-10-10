#!/usr/bin/env node
'use strict';

// Thin launcher so the real CLI logic stays in src/cli.js and remains testable.
const { runCli } = require('../src/cli');

runCli(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
