import { defineProperty } from '@deepseek-ai/cosmokit';
import { Context } from "./context.js";
import { resolveConfig } from "./fiber.js";
import { DisposableList, symbols } from "./utils.js";
/**
 * Return whether an event result should stop a bail-style dispatch.
 *
 * @param value — a listener's return value.
 * @returns `true` unless `value` is `null`, `false`, or `undefined`.
 */
export function isBailed(value) {
    return value !== null && value !== false && value !== undefined;
}
/**
 * Event bus installed as `ctx.events` and mixed into every context.
 *
 * The service supports concurrent, synchronous, serial, bail, and waterfall
 * dispatch and automatically disposes listeners with their owning fiber.
 */
export class EventsService {
    ctx;
    _hooks = Object.create(null);
    constructor(ctx) {
        this.ctx = ctx;
        defineProperty(this, symbols.tracker, {
            property: 'ctx',
            noShadow: true,
        });
        this.on('internal/listener', function (name, listener, options) {
            if (name === 'internal/update' && !options.global) {
                const hooks = this.fiber._hooks['internal/update'] ??= new DisposableList();
                const method = options.prepend ? 'unshift' : 'push';
                return this.fiber.effect(() => hooks[method](listener), 'ctx.on("internal/update")');
            }
        });
        this.on('internal/update', function (config, next) {
            const cbs = [...this._hooks['internal/update'] || []];
            const _next = () => {
                const cb = cbs.shift() ?? next;
                return cb.call(this, config, _next);
            };
            return _next();
        }, { global: true, prepend: true });
        this.on('internal/config', (fiber, next) => {
            const config = next();
            return fiber.runtime ? resolveConfig(fiber.runtime, config) : config;
        });
    }
    _resolve(type, args) {
        const thisArg = typeof args[0] === 'object' || typeof args[0] === 'function' ? args.shift() : null;
        const name = args.shift();
        if ((typeof name !== 'string' || !name.startsWith('internal/')) && this._hooks['internal/dispatch']?.length) {
            this.emit('internal/dispatch', type, name, args, thisArg);
        }
        const filter = thisArg?.[Context.filter];
        return [thisArg, (this._hooks[name] || [])
                .filter(hook => hook.global || !filter || filter.call(thisArg, hook.ctx)).map(hook => hook.callback)];
    }
    /**
     * Resolve bound callbacks using the event's context filter.
     * @param type Dispatch mode reported to observers.
     * @param args Dispatch arguments, consumed through the event name.
     * @returns Matching callbacks bound to the dispatch receiver.
     * DSH retains callback enumeration for per-listener error containment.
     */
    dispatch(type, args) {
        const [thisArg, callbacks] = this._resolve(type, args);
        return callbacks.map(callback => callback.bind(thisArg));
    }
    /**
     * Run listeners concurrently and wait for all of them.
     *
     * @param args — optional `this`, the event name, then listener arguments.
     * @returns a promise resolving once every listener has settled.
     */
    async parallel(...args) {
        const [thisArg, callbacks] = this._resolve('parallel', args);
        const results = await Promise.allSettled(callbacks.map(async (callback) => Reflect.apply(callback, thisArg, args)));
        const errors = results.filter((result) => result.status === 'rejected');
        if (errors.length)
            throw new AggregateError(errors.map(error => error.reason));
    }
    /**
     * Run listeners synchronously without waiting for returned promises.
     *
     * @param args — optional `this`, the event name, then listener arguments.
     */
    emit(...args) {
        const [thisArg, callbacks] = this._resolve('emit', args);
        for (const callback of callbacks)
            Reflect.apply(callback, thisArg, args);
    }
    /**
     * Run listeners in order, awaiting each, until one returns a bail value.
     *
     * @param args — optional `this`, the event name, then listener arguments.
     * @returns the first bail value (see {@link isBailed}), if any.
     */
    async serial(...args) {
        const [thisArg, callbacks] = this._resolve('serial', args);
        for (const callback of callbacks) {
            const result = await Reflect.apply(callback, thisArg, args);
            if (isBailed(result))
                return result;
        }
    }
    /**
     * Run listeners synchronously until one returns a bail value.
     *
     * @param args — optional `this`, the event name, then listener arguments.
     * @returns the first bail value (see {@link isBailed}), if any.
     */
    bail(...args) {
        const [thisArg, callbacks] = this._resolve('bail', args);
        for (const callback of callbacks) {
            const result = Reflect.apply(callback, thisArg, args);
            if (isBailed(result))
                return result;
        }
    }
    /**
     * Compose listeners around the final `next` callback.
     *
     * The last dispatch argument is treated as the innermost `next`. Listeners
     * run outermost-first; a listener that does not call `next()` vetoes the
     * rest of the chain, including the built-in behavior.
     *
     * @param args — optional `this`, the event name, listener arguments, then `next`.
     * @returns the outermost listener's return value.
     */
    waterfall(...args) {
        const [thisArg, callbacks] = this._resolve('waterfall', args);
        const inner = args.pop();
        const dispatch = () => {
            const callback = callbacks.shift();
            if (!callback)
                return inner();
            let called = false;
            const next = () => {
                if (called)
                    throw new Error('next() called multiple times');
                called = true;
                return dispatch();
            };
            return Reflect.apply(callback, thisArg, [...args, next]);
        };
        return dispatch();
    }
    register(label, name, callback, options) {
        const method = options.prepend ? 'unshift' : 'push';
        return this.ctx.fiber.effect(() => {
            const hooks = this._hooks[name] ??= [];
            hooks[method]({ ctx: this.ctx, callback, ...options });
            return () => this.unregister(name, callback);
        }, label);
    }
    unregister(name, callback) {
        const hooks = this._hooks[name];
        if (!hooks)
            return;
        const index = hooks.findIndex(hook => hook.callback === callback);
        if (index >= 0) {
            hooks.splice(index, 1);
            if (!hooks.length)
                delete this._hooks[name];
            return true;
        }
    }
    /**
     * Register an event listener owned by the current fiber.
     *
     * The listener is removed automatically when the fiber unloads. Throws
     * `CordisError('INACTIVE_EFFECT')` if the fiber is already disposed.
     *
     * @param name — the event name to listen for.
     * @param listener — called with the dispatch arguments.
     * @param options — listener options; a boolean is shorthand for `prepend`.
     * @returns a disposer removing the listener; `true` if it was still registered.
     */
    on(name, listener, options) {
        if (typeof options !== 'object') {
            options = { prepend: options };
        }
        // handle special events
        this.ctx.fiber.assertActive();
        listener = this.ctx.reflect.bind(listener);
        const result = this.bail(this.ctx, 'internal/listener', name, listener, options);
        if (result)
            return result;
        const label = `ctx.on(${typeof name === 'string' ? JSON.stringify(name) : name.toString()})`;
        return this.register(label, name, listener, options);
    }
    /**
     * Register an event listener that disposes itself after the first call.
     *
     * @param name — the event name to listen for.
     * @param listener — called at most once with the dispatch arguments.
     * @param options — listener options; a boolean is shorthand for `prepend`.
     * @returns a disposer removing the listener; `true` if it was still registered.
     */
    once(name, listener, options) {
        const dispose = this.on(name, function (...args) {
            dispose();
            return listener.apply(this, args);
        }, options);
        return dispose;
    }
}
//# sourceMappingURL=events.js.map