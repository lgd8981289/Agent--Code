/** 按顺序关闭依赖；一项失败也继续释放其余资源，原业务结果由调用者保留。 */
export async function cleanupResources(tasks: Array<() => unknown | Promise<unknown>>) {
  const failures: unknown[] = [];
  for (const task of tasks) {
    try {
      await task();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}
