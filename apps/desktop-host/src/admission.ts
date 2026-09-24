/** Desktop admission Provider: the normal WebServer routes share one private update gate. */
/* The explicit constructor argument sets the service injection key. */
import { Service, type Context } from '@deepseek-ai/cordis'
import WebServer, { type WebRoute, type WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'

declare module '@deepseek-ai/cordis' {
  interface Context { desktopAdmission: DesktopAdmission }
}

/** Process-local control consumed by the Web Provider and the private IPC adapter. */
export class DesktopAdmission extends Service {
  locked = false
  stopping = false
  pending = 0
  constructor(ctx: Context) {
    super(ctx, 'desktopAdmission')
    this.name = 'desktopAdmission'
  }
  stop(): void { this.stopping = true; this.locked = true }
}

/** WebServer Provider preserving all existing HTTP authentication and route implementations. */
export default class DesktopWebServer extends WebServer {
  static inject = ['desktopAdmission']

  private guard(handler: WebRoute['handler']): WebRoute['handler'] {
    return async (request, response) => {
      const gate = this.ctx.desktopAdmission
      if (gate.locked || gate.stopping) {
        response.writeHead(503, { 'content-type': 'text/plain', connection: 'close' })
        response.end('Desktop Host admission is paused.')
        return
      }
      // GET streams do not start business work and may remain open indefinitely.
      const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method ?? '')
      if (mutation) gate.pending++
      try { await handler(request, response) } finally { if (mutation) gate.pending-- }
    }
  }

  override register(route: WebRoute): () => void { return super.register({ ...route, handler: this.guard(route.handler) }) }
  override registerFallback(handler: WebRoute['handler']): () => void { return super.registerFallback(this.guard(handler)) }
  override registerUpgrade(route: WebUpgradeRoute): () => void {
    return super.registerUpgrade({ ...route, handler: (request, socket, head) => {
      if (this.ctx.desktopAdmission.locked || this.ctx.desktopAdmission.stopping) {
        socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
        return
      }
      return route.handler(request, socket, head)
    } })
  }
}
