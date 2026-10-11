const KEEP_ALIVE_MS = 20_000;

/**
 * Long work (a slow LLM, a model download) can outlast the idle timeout of the MV3 event page;
 * an extension API call every 20 s resets that timer so the work can finish and be recorded.
 */
export async function whileKeepingAlive<T>(fn: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => {
    browser.runtime.getPlatformInfo().catch(() => {});
  }, KEEP_ALIVE_MS);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}
