/** Generic unary RPC contracts shared by the Host and Client Connection halves. */

import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { AuthenticationCapability, AuthenticationPrincipal } from '@deepseek-ai/dsh-authentication'

/** Trust fence applied before a Host RPC channel reaches its handler. */
export type ConnectionRpcAuthority = 'trusted-host' | 'loopback'

/** Registration policy for one logical RPC channel. */
export interface ConnectionRpcHandlerOptions {
  /** Browser authority accepted by every endpoint in this channel. */
  readonly authority: ConnectionRpcAuthority
  /** Capability required by every endpoint on a dedicated channel. */
  readonly requiredCapability: AuthenticationCapability
}

/** Authorization metadata for one channel-relative endpoint. */
export interface ConnectionRpcEndpointPolicy {
  readonly requiredCapability: AuthenticationCapability
}

/** Explicit interceptor claim that must be denied rather than delegated. */
export interface ConnectionRpcEndpointDenial {
  readonly denied: true
}

/** Authenticated invocation decoded from one Connection RPC request. */
export interface ConnectionRpcInvocation {
  readonly endpoint: string
  readonly payload: unknown
  readonly signal: AbortSignal
  readonly principal: AuthenticationPrincipal
}

/** Handler invoked after Connection has authenticated and decoded the transport envelope. */
export type ConnectionRpcHandler = (invocation: ConnectionRpcInvocation) => Promise<RpcResult<unknown>>

/** Resolve authorization metadata and ownership for one endpoint. */
export type ConnectionRpcEndpointResolver = (
  endpoint: string,
) => ConnectionRpcEndpointPolicy | ConnectionRpcEndpointDenial | undefined

/** Host registry for logical RPC channels carried by the current transport. */
export interface HostConnectionRpc {
  /**
   * Register one absolute channel prefix and its trust policy.
   * @param channel - absolute logical channel such as `/rpc`.
   * @param handler - decoded endpoint handler returning the existing RPC result shape.
   * @param options - channel trust policy.
   * @returns asynchronous disposer removing the channel and its physical route.
   */
  handle(
    channel: string,
    handler: ConnectionRpcHandler,
    options: ConnectionRpcHandlerOptions,
  ): () => Promise<void>

  /**
   * Intercept owned endpoints on the shared `/api` channel before its fallback.
   * @param channel - reserved shared channel; currently `/api`.
   * @param resolveEndpoint - synchronous endpoint ownership and policy resolver.
   * @param handler - decoded endpoint handler returning the existing RPC result shape.
   * @param options - trust policy for every endpoint claimed by this interceptor.
   * @returns asynchronous disposer removing the interceptor.
   */
  intercept(
    channel: '/api',
    resolveEndpoint: ConnectionRpcEndpointResolver,
    handler: ConnectionRpcHandler,
    options: ConnectionRpcHandlerOptions,
  ): () => Promise<void>
}

/** Host `ctx.connection` shape consumed by transport-independent adapters. */
export interface HostConnectionHandle {
  /** Generic RPC channel registry. */
  readonly rpc: HostConnectionRpc
}

/** Client caller for logical RPC channels carried by the current transport. */
export interface ClientConnectionRpc {
  /**
   * Call one endpoint through an already registered logical channel.
   * @param channel - absolute logical channel such as `/api`.
   * @param endpoint - channel-relative endpoint such as `goals/create`.
   * @param payload - channel-owned request payload.
   * @param signal - optional caller cancellation.
   * @returns the existing RPC success/error result; correlation stays inside Connection.
   */
  call(
    channel: string,
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<RpcResult<unknown>>
}
