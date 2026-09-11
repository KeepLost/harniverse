/**
 * Preset-selected model-facing scheduler tools (`schedule_create`,
 * `schedule_list`, `schedule_delete`) over the host `ctx.scheduler` service.
 * The service stays on the host plane; what a preset row chooses is whether
 * its agent can call these tools, mirroring `dsh-tool-goal`.
 * @module @deepseek-ai/dsh-tool-scheduler
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ScheduleRuleError } from '@deepseek-ai/dsh-scheduler'
import type { SchedulerRule } from '@deepseek-ai/dsh-scheduler/types'

/** Cordis plugin name. */
export const name = 'tool-scheduler'

/** Host scheduler service required before the tools can execute. */
export const inject = ['scheduler', 'tools']

/** Register the three scheduler tools on the mounting (preset agent) scope. */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'schedule_create',
    description: 'Schedule one prompt to run later in this session or in a dedicated job session, optionally on a repeating interval and optionally with a fresh context each run. Exactly one timing parameter (run_at or after_minutes) is required; add every_minutes to repeat.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Prompt to deliver at the scheduled time.' },
      run_at: { type: 'string', description: 'RFC 3339 datetime (or naive local datetime) of the first run.' },
      after_minutes: { type: 'number', description: 'Delay before the first run, in minutes.' },
      every_minutes: { type: 'number', description: 'Repeat interval in minutes (minimum 5), anchored at the first run.' },
      target: { type: 'string', enum: ['current', 'job'], description: 'Deliver into this session (current) or a dedicated job session (job).' },
      context: { type: 'string', enum: ['continue', 'fresh'], description: 'Continue the existing context (continue) or reset it before each run (fresh).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scheduleId: { type: 'string', required: true },
          nextDue: { type: 'string', required: true },
          target: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Scheduled task ${value.scheduleId} created; the first run is at ${value.nextDue} in the ${value.target} session${args.every_minutes === undefined ? '' : `, repeating every ${String(args.every_minutes)} minutes`}.`,
      }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('schedule_create requires a calling agent')
      const now = Date.now()
      const anchorMs = args.run_at !== undefined
        ? Date.parse(args.run_at)
        : args.after_minutes !== undefined
          ? now + args.after_minutes * 60_000
          : undefined
      if (args.run_at !== undefined && args.after_minutes !== undefined) {
        throw new ScheduleRuleError('pass exactly one of run_at or after_minutes')
      }
      if (anchorMs === undefined || !Number.isFinite(anchorMs)) {
        throw new ScheduleRuleError('one valid timing parameter (run_at or after_minutes) is required')
      }
      const anchorIso = new Date(anchorMs).toISOString()
      const rule: SchedulerRule = args.every_minutes === undefined
        ? args.run_at !== undefined
          ? { kind: 'at', at: anchorIso }
          : { kind: 'after', delayMs: anchorMs - now }
        : { kind: 'every', intervalMs: args.every_minutes * 60_000, anchor: anchorIso }
      const target = args.target === 'job' ? { kind: 'job' as const } : { kind: 'current' as const }
      const record = await ctx.scheduler.create({
        prompt: args.prompt,
        rule,
        target,
        contextMode: args.context === 'fresh' ? 'fresh' : 'continue',
        createdBy: { kind: 'model', sessionId: exec.agent.session.id },
      })
      return {
        scheduleId: record.id,
        // v8 ignore next 1 -- create always stores the first due moment
        nextDue: new Date(record.nextDue ?? record.createdAt).toISOString(),
        target: target.kind,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'schedule_list',
    description: 'List scheduled tasks owned by this session, earliest first.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          schedules: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                scheduleId: { type: 'string', required: true },
                prompt: { type: 'string', required: true },
                status: { type: 'string', required: true },
                nextDue: { type: 'string', required: true },
                target: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        // v8 ignore next 1 -- the output schema requires schedules; the fallback only guards a malformed caller
        const rows = value.schedules
        return [{
          type: 'text',
          text: rows.length === 0
            ? 'No scheduled tasks owned by this session.'
            : rows.map(row => `${row.scheduleId} [${row.status}] next ${row.nextDue}: ${row.prompt}`).join('\n'),
        }]
      },
    },
    execute(_args, exec) {
      if (exec.agent === undefined) throw new Error('schedule_list requires a calling agent')
      const records = ctx.scheduler.listForSession(exec.agent.session.id)
      return Promise.resolve({
        schedules: records.map(record => ({
          scheduleId: record.id,
          prompt: record.prompt,
          status: record.status,
          // v8 ignore next 1 -- exhausted projections are covered by the scheduler dispatch tests
          nextDue: record.nextDue === undefined ? 'none' : new Date(record.nextDue).toISOString(),
          // v8 ignore next 1 -- dispatched job projections are covered by the scheduler dispatch tests
          target: record.jobSessionId === undefined ? record.target.kind : 'job',
        })),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'schedule_delete',
    description: 'Cancel one scheduled task owned by this session.',
    parameters: {
      schedule_id: { type: 'string', required: true, description: 'Schedule id from schedule_create or schedule_list.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          deleted: { type: 'boolean', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.deleted
          ? `Scheduled task ${args.schedule_id} was cancelled.`
          : `No scheduled task ${args.schedule_id} owned by this session was found.`,
      }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('schedule_delete requires a calling agent')
      const deleted = await ctx.scheduler.remove(args.schedule_id, exec.agent.session.id)
      return { deleted }
    },
  }))
}
