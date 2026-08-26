export interface WorkbenchAttentionReconciler {
  reconcile(input: { prompt: string; reasonCode: string; workbenchId: string }): Promise<number>;
}
