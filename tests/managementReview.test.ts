import { describe, expect, it, vi } from 'vitest';
import { LiveFunctionDispatcher } from '../src/openai/liveFunctionTools.js';
import { inspectReviewDocument, reviewReferenceSchema } from '../src/managementReview.js';
import type { AppConfig } from '../src/config.js';
import { crmStartSchema, crmInterviewInstructions } from '../src/crmVoice.js';
import { buildGptLiveSessionStart } from '../src/openai/gptLiveVoiceSession.js';
import { reviewDocumentTool } from '../src/managementReview.js';

const reference = { reviewId: '11111111-1111-4111-8111-111111111111', documentId: '22222222-2222-4222-8222-222222222222', participantTelegramId: '1234' };
const context = { ...reference, title: 'Sample brochure', questions: ['Cover feedback?'], constraints: 'Keep approved copy', briefing: 'Two pages',
  pages: [{number: 2, text: 'Page two copy', imageBase64: 'aW1hZ2U=', mimeType: 'image/png' as const}] };
const config = {OPENAI_API_KEY: 'test-only', OPENAI_GPT_LIVE_BACKEND_MODEL: 'configured-model'} as AppConfig;

describe('management review document inspection', () => {
  it('sends exact requested page image and text to Responses, without storage or tools', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({status:'completed',output:[{content:[{type:'output_text',text:'Page 2: the heading is small.'}]}]})));
    const load = vi.fn(async () => context);
    const answer = await inspectReviewDocument(config, {page_numbers:[2],question:'Is the heading legible?'}, load, fetcher);
    expect(load).toHaveBeenCalledWith([2]);
    const request = JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(request.store).toBe(false);
    expect(request.tools).toBeUndefined();
    expect(request.input[0].content[2].image_url).toBe('data:image/png;base64,aW1hZ2U=');
    expect(answer).toMatchObject({ok:true,page_numbers:[2],documentId:reference.documentId});
  });
  it('fails on unavailable page rather than answering from a different page', async () => {
    const fetcher = vi.fn();
    await expect(inspectReviewDocument(config,{page_numbers:[1],question:'Which logo?'}, async () => context, fetcher)).rejects.toThrow('requested_pages_unavailable');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('requires actual images for visual answers', async () => {
    await expect(inspectReviewDocument(config,{page_numbers:[2],question:'Color?'}, async () => ({...context,pages:[{number:2,text:'Only extracted text'}]}))).rejects.toThrow('page_image_missing');
  });
  it('rejects arbitrary document URLs, excessive page requests and incomplete answers', async () => {
    await expect(inspectReviewDocument(config,{page_numbers:[2],question:'Color?',url:'https://example.com'}, async () => context)).rejects.toThrow();
    await expect(inspectReviewDocument(config,{page_numbers:[1,2,3,4,5],question:'Color?'}, async () => context)).rejects.toThrow();
    await expect(inspectReviewDocument(config,{page_numbers:[2],question:'Color?'}, async () => context,
      vi.fn(async () => new Response(JSON.stringify({status:'incomplete',output:[]}))))).rejects.toThrow('vision_incomplete');
  });
  it('only enables tools when explicitly requested by this mission', () => {
    const base = {liveModel:'gpt-live-1', backendModel:'configured-model',instructions:'mission',voice:'cedar'};
    expect(JSON.stringify(buildGptLiveSessionStart(base))).not.toContain('inspect_review_document');
    expect(JSON.stringify(buildGptLiveSessionStart({...base,backendTools:[reviewDocumentTool]}))).toContain('inspect_review_document');
    const request = {sessionId:reference.reviewId,idempotencyKey:'test',to:'+15555550123',missionPrompt:'Review document',reportPeriod:'custom',reviewContext:reference};
    expect(crmStartSchema.parse(request).reviewContext).toEqual(reference);
    expect(() => crmStartSchema.parse({...request,reportPeriod:'weekly'})).toThrow();
    expect(crmInterviewInstructions(crmStartSchema.parse(request))).toContain('call audio is not retained');
  });
});

describe('Live backend function lifecycle', () => {
  const event = (type: string, rest = {}) => ({type:'response.event',delegation_id:'delegation',event:{type,...rest}});
  it('waits for completed output items and response completion; submits all results once', async () => {
    const send = vi.fn(), execute = vi.fn(async () => ({ok:true}));
    const handler = new LiveFunctionDispatcher(send, execute);
    handler.accept(event('response.created',{response:{id:'response'}}));
    handler.accept(event('response.function_call_arguments.done',{arguments:'{}'}));
    expect(execute).not.toHaveBeenCalled();
    const item = {type:'function_call',name:'inspect_review_document',call_id:'call1',arguments:'{}'};
    handler.accept(event('response.output_item.done',{item}));
    handler.accept(event('response.output_item.done',{item}));
    handler.accept(event('response.output_item.done',{item:{...item,call_id:'call2'}}));
    expect(send).not.toHaveBeenCalled();
    handler.accept(event('response.completed',{response:{id:'response',output:[]}}));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(execute).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[2][0]).toEqual({type:'response.create'});
    handler.accept(event('response.completed',{response:{id:'response',output:[]}}));
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it('returns a truthful lookup error without killing the voice call', async () => {
    const send = vi.fn();
    const handler = new LiveFunctionDispatcher(send, async () => {throw new Error('private failure');});
    handler.accept(event('response.created',{response:{id:'r'}}));
    handler.accept(event('response.output_item.done',{item:{type:'function_call',name:'x',call_id:'c',arguments:'{}'}}));
    handler.accept(event('response.completed',{response:{id:'r'}}));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(send.mock.calls)).toContain('document_lookup_unavailable');
    expect(JSON.stringify(send.mock.calls)).not.toContain('private failure');
  });
  it('does not inject late tool results after the call ends', async () => {
    let resolve!: (value: unknown) => void;
    const send = vi.fn();
    const handler = new LiveFunctionDispatcher(send, () => new Promise(r => {resolve=r;}));
    handler.accept(event('response.created',{response:{id:'r'}}));
    handler.accept(event('response.output_item.done',{item:{type:'function_call',name:'x',call_id:'c',arguments:'{}'}}));
    handler.accept(event('response.completed',{response:{id:'r'}}));
    handler.close(); resolve({ok:true}); await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
  });
});
