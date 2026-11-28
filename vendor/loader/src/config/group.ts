import { Context, Service } from '@deepseek-ai/cordis'
import { Entry, type EntryOptions } from './entry.ts'
import { EntryTree } from './tree.ts'

/** Runtime owner for a list of child loader entries. */
export class EntryGroup {
  static readonly key = Symbol.for('cordis.group')

  public data: EntryOptions[] = []
  /** Teardown in flight for entries this group removed, by id, each kept until it settles. */
  private readonly retiring = new Map<string, Promise<void>>()

  constructor(public ctx: Context, public tree: EntryTree) {
    const entry = ctx.fiber.entry
    if (entry) entry.subgroup = this
  }

  get context(): Context {
    return this.ctx
  }

  /**
   * Create an entry, or re-create one under an id this group removed. The
   * re-created entry starts only after the removed entry's fiber finished
   * unloading, so a resource the previous instance releases in its disposers
   * is free when the next one looks for it.
   * @param options - Entry options; an explicit `id` addresses the re-created entry.
   * @returns the entry id.
   */
  async create(options: Omit<EntryOptions, 'id'>) {
    const id = this.tree.ensureId(options)
    const retiring = this.retiring.get(id)
    if (retiring !== undefined) await retiring
    const entry: Entry = this.tree.store[id] ??= new Entry(this.ctx.loader)
    // Entry may be moved from another group,
    // so we need to update the parent reference.
    entry.parent = this
    // Use `create: true` to replace existing entry.options.
    await entry.update(options, true, true)
    return entry.id
  }

  unlink(options: EntryOptions) {
    const config = this.data
    const index = config.indexOf(options)
    if (index >= 0) config.splice(index, 1)
  }

  remove(id: string, isDispose = false) {
    const entry = this.tree.store[id]
    if (!entry || entry.parent !== this) return
    // Unregister before disposal so Loader can distinguish removal from self-disposal.
    delete this.tree.store[id]
    const disposal = entry.fiber?.dispose()
    if (disposal !== undefined) this.retire(id, disposal)
    if (!isDispose) {
      this.unlink(entry.options)
    }
    this.context.emit('loader/partial-dispose', entry, entry.options, false)
  }

  private retire(id: string, disposal: Promise<void>): void {
    // A failed teardown is already logged by Core; it must not fail the re-created entry.
    const settled = disposal.then(() => {}, () => {})
    this.retiring.set(id, settled)
    void settled.then(() => {
      if (this.retiring.get(id) === settled) this.retiring.delete(id)
    })
  }

  async update(config: EntryOptions[]) {
    const oldConfig = this.data as EntryOptions[]
    this.data = config
    const oldMap = Object.fromEntries(oldConfig.map(options => [options.id, options]))
    const newMap = Object.fromEntries(config.map(options => [options.id ?? Symbol('anonymous'), options]))

    // update inner plugins
    const ids = Reflect.ownKeys({ ...oldMap, ...newMap }) as string[]
    await Promise.all(ids.map(async (id) => {
      if (newMap[id]) {
        await this.create(newMap[id]).catch((error) => {
          this.ctx.logger.error(error)
        })
      } else {
        this.remove(id)
      }
    }))
  }

  stop() {
    for (const options of this.data) {
      this.remove(options.id, true)
    }
  }
}

/** Plugin that mounts a nested loader entry group. */
export class Group extends EntryGroup {
  static initial: Omit<EntryOptions, 'id'>[] = []
  static readonly [EntryGroup.key] = true

  constructor(public ctx: Context, public config: EntryOptions[]) {
    super(ctx, ctx.fiber.entry!.parent.tree)
    ctx.on('internal/update', config => this.update(config))
  }

  async* [Service.init]() {
    yield () => this.stop()
    await this.update(this.config)
  }
}
