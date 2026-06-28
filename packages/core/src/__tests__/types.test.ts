// @zaivim/core — Type-level tests for public API quality
// Verifies that exported types don't contain `any` and are well-formed.

import { describe, it, expectTypeOf } from 'vitest';
import type {
  Message,
  Session,
  AgentHandle,
  AgentResult,
  AgentPool,
  ToolDefinition,
  ToolContext,
  IProvider,
  ISecurityProvider,
  ResponseChunk,
  EngineAPI,
  EngineHealth,
  ApprovalHandler,
  FileChangeProposal,
  SkillAdapter,
  ZaiConfig,
  ProviderChatRequest,
  ProviderCapabilities,
  PersonaConfig,
  ForkOptions,
  PendingApproval,
  IAuditor,
  JsonRpcMessage,
  ZaiError,
} from '../index.js';

describe('public API does not contain any', () => {
  // Each `expectTypeOf<T>().not.toBeAny()` verifies that the resolved type
  // is not the implicit `any` type — i.e. all type parameters, dependencies,
  // and nested types are properly typed.

  it('Message', () => {
    expectTypeOf<Message>().not.toBeAny();
  });

  it('Session', () => {
    expectTypeOf<Session>().not.toBeAny();
  });

  it('AgentHandle', () => {
    expectTypeOf<AgentHandle>().not.toBeAny();
  });

  it('AgentResult', () => {
    expectTypeOf<AgentResult>().not.toBeAny();
  });

  it('AgentPool', () => {
    expectTypeOf<AgentPool>().not.toBeAny();
  });

  it('ToolDefinition', () => {
    expectTypeOf<ToolDefinition>().not.toBeAny();
  });

  it('ToolContext', () => {
    expectTypeOf<ToolContext>().not.toBeAny();
  });

  it('IProvider', () => {
    expectTypeOf<IProvider>().not.toBeAny();
  });

  it('ISecurityProvider', () => {
    expectTypeOf<ISecurityProvider>().not.toBeAny();
  });

  it('ResponseChunk', () => {
    expectTypeOf<ResponseChunk>().not.toBeAny();
  });

  it('EngineAPI', () => {
    expectTypeOf<EngineAPI>().not.toBeAny();
  });

  it('EngineHealth', () => {
    expectTypeOf<EngineHealth>().not.toBeAny();
  });

  it('ApprovalHandler', () => {
    expectTypeOf<ApprovalHandler>().not.toBeAny();
  });

  it('FileChangeProposal', () => {
    expectTypeOf<FileChangeProposal>().not.toBeAny();
  });

  it('SkillAdapter', () => {
    expectTypeOf<SkillAdapter>().not.toBeAny();
  });

  it('ZaiConfig', () => {
    expectTypeOf<ZaiConfig>().not.toBeAny();
  });

  it('ProviderChatRequest', () => {
    expectTypeOf<ProviderChatRequest>().not.toBeAny();
  });

  it('ProviderCapabilities', () => {
    expectTypeOf<ProviderCapabilities>().not.toBeAny();
  });

  it('PersonaConfig', () => {
    expectTypeOf<PersonaConfig>().not.toBeAny();
  });

  it('ForkOptions', () => {
    expectTypeOf<ForkOptions>().not.toBeAny();
  });

  it('PendingApproval', () => {
    expectTypeOf<PendingApproval>().not.toBeAny();
  });

  it('IAuditor', () => {
    expectTypeOf<IAuditor>().not.toBeAny();
  });

  it('JsonRpcMessage', () => {
    expectTypeOf<JsonRpcMessage>().not.toBeAny();
  });

  it('ZaiError', () => {
    expectTypeOf<ZaiError>().not.toBeAny();
  });
});
