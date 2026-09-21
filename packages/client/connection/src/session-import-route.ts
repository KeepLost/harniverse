/** Authenticated archival import through the existing HTTP connection plugin. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-import'
import { ForeignLogError } from '@deepseek-ai/dsh-session-import'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { authenticateIncoming, rejectUnauthorized } from './inbound-auth.ts'
import { isTrustedApiRequest } from './api-request-trust.ts'

/**
 * Register raw JSONL intake using the connection's trust and body limits.
 * @param ctx - owning HTTP connection scope.
 * @param trustedHosts - allowed HTTP authorities.
 * @param trustedOrigins - allowed browser origins.
 * @param maxBytes - maximum source-artifact size.
 */
export function registerSessionImportRoute(
  ctx: Context, trustedHosts: readonly string[], trustedOrigins: readonly string[], maxBytes: number,
): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/api/session/import',
    async handler(req, res) {
      const reply = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      if (!isTrustedApiRequest(req, trustedHosts, trustedOrigins)) { reply(403, { error: 'forbidden' }); return }
      const decision = await authenticateIncoming(ctx, req, 'http-api')
      if (decision.kind === 'rejected') { rejectUnauthorized(res, decision); return }
      if (!decision.principal.capabilities.includes('harniverse.operate')) { reply(403, { error: 'forbidden' }); return }
      if (req.method !== 'POST') { reply(405, { error: 'POST required' }); return }
      const importer = ctx.get('sessionImport')
      const registry = ctx.get('workspaceRegistry')
      if (importer === undefined || registry === undefined) { reply(501, { error: 'session import unavailable' }); return }
      const workspaceId = req.headers['x-session-workspace']
      const mode = req.headers['x-session-supervision'] ?? 'supervised'
      if (typeof workspaceId !== 'string' || (mode !== 'supervised' && mode !== 'unsupervised')) {
        reply(400, { error: 'x-session-workspace and a valid x-session-supervision are required' }); return
      }
      const workspace = registry.get(WorkspaceId(workspaceId))
      if (workspace === undefined) { reply(404, { error: 'workspace not found' }); return }
      if (Number(req.headers['content-length']) > maxBytes) { reply(413, { error: 'source exceeds import byte limit' }); return }
      try {
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of req) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
          size += bytes.length
          if (size > maxBytes) { reply(413, { error: 'source exceeds import byte limit' }); return }
          chunks.push(bytes)
        }
        if (registry.get(workspace.id) !== workspace) { reply(409, { error: 'workspace changed during upload' }); return }
        const result = await importer.import({
          artifact: Buffer.concat(chunks), cwd: workspace.path, posture: { supervisionMode: mode },
        })
        // Settlement already succeeded. Report its identity even if grouping
        // fails, so the caller can open the loose session without reimporting.
        let attached = true
        try { await workspace.attachSession(result.sessionId) } catch (error) {
          attached = false
          ctx.logger.warn('imported session could not join its workspace')
          ctx.logger.warn(error)
        }
        reply(201, { ...result, workspaceId, attached })
      } catch (error) {
        const invalid = error instanceof ForeignLogError || error instanceof TypeError
        reply(invalid ? 400 : 500, { error: error instanceof Error ? error.message : 'import failed' })
      }
    },
  }), 'client-connection: session import route')
}
