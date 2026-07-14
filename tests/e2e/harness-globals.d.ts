import type { CompatRequest, CompatResult, MatrixEntry } from '../../src/harness/compat.ts';

// The compat harness exposes these on window for the Playwright driver.
declare global {
  interface Window {
    __runCompat: (req: CompatRequest) => Promise<CompatResult>;
    __runSupportMatrix: (configs?: CompatRequest[]) => Promise<MatrixEntry[]>;
    __defaultConfigs: CompatRequest[];
  }
}
