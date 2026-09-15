/** Responses delegation tools finish as a group before response.create.
 * Live continues streaming audio while the backend reads documents.
 */
export interface LiveFunctionTool {
  type: 'function'; name: string; description: string;
  parameters: Record<string, unknown>; strict: boolean;
}
type FunctionItem = { type: string; call_id: string; name: string; arguments: string };
interface ResponseBatch { calls: Map<string, FunctionItem>; processing: boolean; }

export class LiveFunctionDispatcher {
  private batches = new Map<string, ResponseBatch>();
  private responseByDelegation = new Map<string, string>();
  private closed = false;
  constructor(private readonly send: (event: Record<string, unknown>) => void,
    private readonly execute: (name: string, args: unknown) => Promise<unknown>) {}

  accept(envelope: Record<string, any>): void {
    if (this.closed || envelope.type !== 'response.event') return;
    const event = envelope.event;
    if (!event || typeof event !== 'object') return;
    const delegation = envelope.delegation_id;
    if (event.type === 'response.created' && typeof event.response?.id === 'string') {
      this.responseByDelegation.set(delegation, event.response.id);
      if (!this.batches.has(event.response.id)) this.batches.set(event.response.id, { calls: new Map(), processing: false });
    }
    const id = event.response_id ?? event.response?.id ?? this.responseByDelegation.get(delegation);
    const batch = this.batches.get(id);
    if (!batch || batch.processing) return;
    if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
      const item = event.item;
      if (typeof item.call_id === 'string' && typeof item.name === 'string' && typeof item.arguments === 'string')
        batch.calls.set(item.call_id, item);
    }
    if (event.type === 'response.completed') {
      batch.processing = true;
      void this.finish(batch);
    }
    if (['response.failed', 'response.cancelled', 'response.incomplete'].includes(event.type)) batch.processing = true;
  }

  close(): void { this.closed = true; this.batches.clear(); this.responseByDelegation.clear(); }

  private async finish(batch: ResponseBatch): Promise<void> {
    if (!batch.calls.size) return;
    for (const item of batch.calls.values()) {
      let output: unknown;
      try {
        if (item.arguments.length > 16000) throw new Error('arguments_too_large');
        output = await this.execute(item.name, JSON.parse(item.arguments));
      } catch {
        output = { ok: false, error: 'document_lookup_unavailable',
          guidance: 'Do not guess visual details or promise feasibility. Ask a clarification or capture the question for Alex.' };
      }
      if (this.closed) return;
      this.send({ type: 'response.item.create', item: { type: 'function_call_output', call_id: item.call_id, output: JSON.stringify(output) } });
    }
    if (!this.closed) this.send({ type: 'response.create' });
  }
}
