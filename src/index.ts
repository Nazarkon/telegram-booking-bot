import { FATAL_EXIT_CODE, runApp } from './app.js';
import { loadConfig } from './config.js';

try {
  const config = loadConfig();
  runApp({ config, signals: process, exit: (code) => process.exit(code) }).catch(
    (error: unknown) => {
      // runApp logs startup and polling failures itself; this is only a last resort.
      console.error(error instanceof Error ? error.message : 'unexpected failure');
      process.exit(FATAL_EXIT_CODE);
    },
  );
} catch (error) {
  // The logger does not exist yet. ConfigError messages never contain values.
  console.error(error instanceof Error ? error.message : 'startup failed');
  process.exit(FATAL_EXIT_CODE);
}
