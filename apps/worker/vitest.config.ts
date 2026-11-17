import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    maxWorkers: 1,
    fileParallelism: false,
    env: {
      TEMP: 'F:\\apps\\hala\\CRM\\Front-end\\.tmp',
      TMP: 'F:\\apps\\hala\\CRM\\Front-end\\.tmp',
    },
  },
});
