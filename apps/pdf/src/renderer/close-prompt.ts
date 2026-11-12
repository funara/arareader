/** Wait for all renderer-owned PDF writes before acknowledging a native close prompt. */
export async function waitForSavesBeforeClosePrompt(
  pendingSaves: readonly (Promise<unknown> | null)[],
): Promise<void> {
  await Promise.allSettled(pendingSaves.filter((save): save is Promise<unknown> => save !== null))
}
