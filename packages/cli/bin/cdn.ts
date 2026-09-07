#!/usr/bin/env bun
// The executable. Everything it does lives in ../src/cli.ts, which exports the
// CLI rather than running it — so a test can `serve()` it with its own argv and
// its own stdout, and `incur gen` can import it, without either of them
// triggering a real run.

import cli from "../src/cli.ts";

cli.serve();
