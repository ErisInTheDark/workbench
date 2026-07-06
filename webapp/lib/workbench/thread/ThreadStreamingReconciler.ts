/*
 * Exports:
 * - default ThreadStreamingReconciler: owns live streaming item key lifecycle for thread reconciliation. Keywords: thread, streaming, reconciliation, controller.
 */

export default class ThreadStreamingReconciler {
  private readonly clientCreatedStreamingItemKeys = new Set<string>();

  addClientCreatedItemKey(key: string) {
    this.clientCreatedStreamingItemKeys.add(key);
  }

  clearClientCreatedItemKeys() {
    this.clientCreatedStreamingItemKeys.clear();
  }

  hasClientCreatedItemForTurn(turnId: string) {
    const prefix = `${turnId}:`;
    for (const key of this.clientCreatedStreamingItemKeys) {
      if (key.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }

  forgetReplacedStreamingItem(clientKey: string, canonicalKey: string) {
    if (clientKey === canonicalKey) {
      this.clientCreatedStreamingItemKeys.delete(clientKey);
      return;
    }

    this.clientCreatedStreamingItemKeys.delete(clientKey);
  }

  forgetStreamingItemKey(key: string) {
    this.clientCreatedStreamingItemKeys.delete(key);
  }

  hasClientCreatedItemKey(key: string) {
    return this.clientCreatedStreamingItemKeys.has(key);
  }
}
