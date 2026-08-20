import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import type {
  SessionEventSearchPage,
  SessionEventSearchRequest,
  SessionFindHit,
  SessionFindRequest,
  SessionSearchExecContext,
  SessionSearchHit,
  SessionSearchPage,
  SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'

/** Test-only concrete query service for backend-independent behavior. */
export class TestSessionQueryEngine extends SessionQueryEngine {
  override findSessions(
    _request: SessionFindRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionFindHit>> {
    return Promise.resolve({ items: [] })
  }

  override searchSessions(
    _request: SessionSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>> {
    return Promise.resolve({ items: [] })
  }

  override async searchEvents(
    request: SessionEventSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionEventSearchPage> {
    return {
      session: (await this.readSurface(request.sessionId)).session,
      items: [],
    }
  }
}
