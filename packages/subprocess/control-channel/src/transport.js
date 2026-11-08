/**
 * The optional stream-attached control transport: one duplex pair carrying
 * the frame codec, with caller-owned cancellation and deadline, close-grace
 * escalation, and the lifecycle state machine driven to quiescence and
 * cleanup. Providers supply the streams and the process-range termination
 * hook; this module never spawns or kills anything itself.
 *
 * @module @deepseek-ai/dsh-control-channel
 */
import { DEFAULT_CONTROL_CHANNEL_LIMITS } from "./types.js";
import { ControlFrameDecoder, ControlProtocolError, ControlSendQueue, encodeControlFrame, PendingCallGate, } from "./codec.js";
import { assertControlTransition } from "./lifecycle.js";
/** Captured at module load: hostile children may rebind constructors. */
const intrinsicObjectCreate = Object.create;
/** Rejection reason for one failed {@link ControlChannelTransport.call}. */
export class ControlCallError extends Error {
    /** The orthogonal failure vocabulary entry this rejection carries. */
    failure;
    constructor(failure) {
        super(failure.message);
        this.name = 'ControlCallError';
        this.failure = failure;
    }
}
/**
 * The stream-attached control channel end. Attaches to one duplex pair,
 * pairs calls with replies under the pending-call gate, applies send
 * backpressure at the write site, records exactly one terminal outcome, and
 * drives the lifecycle through quiescence and cleanup — the first outcome
 * stays stable while cleanup completes and reports independently.
 */
export class ControlChannelTransport {
    limits;
    input;
    output;
    forceTerminate;
    handlers;
    decoder = new ControlFrameDecoder();
    sendQueue;
    gate;
    // Null-prototype id table via captured create: this transport also runs
    // inside hostile child processes whose programs may rebind constructors,
    // and pending-reply accounting must never consult an armed prototype.
    pending = intrinsicObjectCreate(null);
    cleanupErrors = [];
    nextCallId = 1;
    state = 'starting';
    outcomeRecorded = false;
    outcomeResolve;
    settleResolve;
    outcomePromise;
    settledPromise;
    graceTimer;
    deadlineTimer;
    disposed = false;
    constructor(options) {
        this.limits = options.limits ?? DEFAULT_CONTROL_CHANNEL_LIMITS;
        this.input = options.input;
        this.output = options.output;
        const forceTerminate = options.forceTerminate;
        this.forceTerminate = forceTerminate === undefined ? undefined : () => forceTerminate();
        this.handlers = options.handlers ?? {};
        this.sendQueue = new ControlSendQueue(this.limits);
        this.gate = new PendingCallGate(this.limits);
        this.outcomePromise = new Promise((resolve) => {
            this.outcomeResolve = resolve;
        });
        this.settledPromise = new Promise((resolve) => {
            this.settleResolve = resolve;
        });
        this.input.on('data', (chunk) => {
            this.receive(chunk);
        });
        this.input.on('end', () => {
            this.terminate({ kind: 'process-exit', message: 'peer closed the channel without a terminal frame' }, 'channel-closed');
            this.checkSettled();
        });
        this.input.on('error', (cause) => {
            this.terminate({ kind: 'io', message: `input stream failed: ${cause.message}` }, 'channel-closed');
            this.checkSettled();
        });
        this.output.on('error', (cause) => {
            this.terminate({ kind: 'io', message: `output stream failed: ${cause.message}` }, 'channel-closed');
            this.checkSettled();
        });
        this.output.on('finish', () => {
            this.checkSettled();
        });
        this.input.on('close', () => {
            this.checkSettled();
        });
        this.output.on('close', () => {
            this.checkSettled();
        });
        const signal = options.signal;
        if (signal !== undefined) {
            if (signal.aborted) {
                this.cancel(String(signal.reason));
            }
            else {
                signal.addEventListener('abort', () => { this.cancel(String(signal.reason)); }, { once: true });
            }
        }
        if (options.deadlineMs !== undefined) {
            this.deadlineTimer = setTimeout(() => {
                this.terminate({ kind: 'timeout', message: `execution deadline of ${options.deadlineMs}ms expired` }, 'timed-out');
            }, options.deadlineMs);
        }
    }
    /** The current lifecycle state of this channel end. */
    get lifecycleState() {
        return this.state;
    }
    /**
     * The first terminal outcome, exactly once: a `done` frame's value or the
     * failure that ended the execution. A channel disposed before terminating
     * never settles this promise.
     * @returns the recorded outcome.
     */
    outcome() {
        return this.outcomePromise;
    }
    /**
     * Call one target on the peer and await its reply.
     * @param target - fully-qualified invocation target.
     * @param args - JSON-safe call arguments.
     * @param options - per-call reply timeout.
     * @returns the reply's success value.
     * @throws {@link ControlCallError} when the reply reports failure, the
     * per-call timeout expires, or the channel terminated first.
     */
    async call(target, args = [], options = {}) {
        if (this.outcomeRecorded) {
            throw new ControlCallError({ kind: 'protocol', message: 'control channel already terminated' });
        }
        const id = this.nextCallId;
        this.gate.acquire(id);
        this.nextCallId += 1;
        try {
            return await new Promise((resolve, reject) => {
                const entry = {
                    resolve,
                    reject,
                    timer: options.timeoutMs === undefined ? undefined : setTimeout(() => {
                        // oxlint-disable-next-line typescript/no-dynamic-delete -- null-proto table by design (hostile-child hardening)
                        delete this.pending[id];
                        this.gate.release(id);
                        reject(new ControlCallError({ kind: 'timeout', message: `call ${id} (${target}) exceeded its ${options.timeoutMs}ms reply window` }));
                    }, options.timeoutMs),
                };
                this.pending[id] = entry;
                this.send({ kind: 'call', id, target, args });
            });
        }
        finally {
            const entry = this.pending[id];
            if (entry !== undefined) {
                if (entry.timer !== undefined)
                    clearTimeout(entry.timer);
                // oxlint-disable-next-line typescript/no-dynamic-delete -- null-proto table by design (hostile-child hardening)
                delete this.pending[id];
                this.gate.release(id);
            }
        }
    }
    /**
     * Send one bounded progress line to the peer.
     * @param text - bounded human-readable progress text.
     */
    sendLog(text) {
        this.send({ kind: 'log', text });
    }
    /**
     * Report one declared bound to the peer.
     * @param limit - the bound this end hit.
     */
    sendLimit(limit) {
        this.send({ kind: 'limit', limit });
    }
    /**
     * Send this end's terminal outcome to the peer: the executor side of a
     * controlled execution reports its completion value or failure as one
     * `done` frame, which the peer's transport records as its outcome. Sending
     * does not settle THIS end's own lifecycle — the executor ends through
     * disposal or peer closure, so the frame is dropped once this end already
     * terminated.
     * @param outcome - the completion value, or the failure that ended the run.
     */
    sendDone(outcome) {
        if ('error' in outcome) {
            this.send({ kind: 'done', error: outcome.error });
        }
        else {
            this.send(outcome.value === undefined ? { kind: 'done' } : { kind: 'done', value: outcome.value });
        }
    }
    /**
     * Cancel the execution from the caller side: the terminal outcome becomes
     * an `abort` failure unless a first outcome was already recorded.
     * @param reason - why the caller cancelled.
     */
    cancel(reason) {
        this.terminate({ kind: 'abort', message: reason }, 'cancelled');
    }
    /**
     * Resolves once the peer has settled after the terminal outcome: the
     * writable finished, the readable ended, and any close-grace escalation
     * completed. Marks the lifecycle `quiescent`.
     */
    async waitSettled() {
        await this.settledPromise;
    }
    /**
     * Final resource cleanup. Cancels a still-running channel first, then
     * releases timers and listeners and walks the lifecycle to `cleaned-up`.
     * Forced settlement: a peer that ignores the close does not hold cleanup
     * hostage — cooperative settlement is {@link waitSettled}.
     * @returns notes describing every cleanup error; empty when cleanup was clean.
     */
    dispose() {
        if (this.disposed)
            return Promise.resolve(this.cleanupErrors);
        this.disposed = true;
        if (!this.outcomeRecorded) {
            this.terminate({ kind: 'abort', message: 'disposed before a terminal outcome' }, 'channel-closed');
        }
        this.releaseResources();
        this.settleResolve?.();
        this.settleResolve = undefined;
        while (this.state !== 'cleaned-up') {
            this.transition(this.state === 'quiescent' ? 'cleaned-up' : 'quiescent');
        }
        return Promise.resolve(this.cleanupErrors);
    }
    releaseResources() {
        if (this.graceTimer !== undefined) {
            clearTimeout(this.graceTimer);
            this.graceTimer = undefined;
        }
        if (this.deadlineTimer !== undefined)
            clearTimeout(this.deadlineTimer);
        this.input.removeAllListeners();
        this.output.removeAllListeners();
    }
    receive(chunk) {
        let frames;
        try {
            frames = this.decoder.feed(chunk);
        }
        catch (cause) {
            this.terminate({ kind: 'protocol', message: errorMessageOf(cause) }, 'channel-closed');
            return;
        }
        if (this.state === 'starting' && frames.length > 0)
            this.transition('running');
        for (const frame of frames) {
            try {
                this.dispatch(frame);
            }
            catch (cause) {
                if (cause instanceof ControlProtocolError) {
                    this.terminate({ kind: 'protocol', message: cause.message }, 'channel-closed');
                    return;
                }
                this.cleanupErrors[this.cleanupErrors.length] = `frame handler failed: ${errorMessageOf(cause)}`;
            }
        }
    }
    dispatch(frame) {
        switch (frame.kind) {
            case 'reply':
                this.dispatchReply(frame);
                break;
            case 'log':
                this.handlers.onLog?.(frame.text);
                break;
            case 'limit':
                this.handlers.onLimit?.(frame.limit);
                break;
            case 'call':
                void this.serveCall(frame);
                break;
            case 'done':
                this.terminateFromDone(frame);
                break;
            default:
                assertNever(frame, 'ControlFrame dispatch');
        }
    }
    dispatchReply(frame) {
        const entry = this.pending[frame.id];
        if (entry === undefined) {
            this.terminate({ kind: 'protocol', message: `reply for unknown call id ${frame.id}` }, 'channel-closed');
            return;
        }
        if (entry.timer !== undefined)
            clearTimeout(entry.timer);
        // oxlint-disable-next-line typescript/no-dynamic-delete -- null-proto table by design (hostile-child hardening)
        delete this.pending[frame.id];
        this.gate.release(frame.id);
        if (frame.ok)
            entry.resolve(frame.value);
        else
            entry.reject(new ControlCallError({ kind: 'exception', message: frame.message ?? 'call failed' }));
    }
    async serveCall(frame) {
        let reply;
        if (this.handlers.onCall === undefined) {
            reply = { kind: 'reply', id: frame.id, ok: false, message: `no handler serves ${frame.target}` };
        }
        else {
            try {
                reply = { kind: 'reply', id: frame.id, ok: true, value: await this.handlers.onCall(frame) };
            }
            catch (cause) {
                reply = { kind: 'reply', id: frame.id, ok: false, message: errorMessageOf(cause) };
            }
        }
        this.send(reply);
    }
    terminateFromDone(frame) {
        if (this.outcomeRecorded) {
            this.cleanupErrors[this.cleanupErrors.length] = 'peer sent a second terminal frame';
            return;
        }
        const outcome = frame.error === undefined
            ? { kind: 'value', value: frame.value }
            : { kind: 'failure', failure: frame.error };
        this.recordOutcome(outcome, 'result-recorded');
    }
    terminate(failure, terminal) {
        if (this.outcomeRecorded)
            return;
        this.recordOutcome({ kind: 'failure', failure }, terminal);
    }
    recordOutcome(outcome, terminal) {
        this.outcomeRecorded = true;
        if (this.deadlineTimer !== undefined)
            clearTimeout(this.deadlineTimer);
        if (this.state === 'starting') {
            this.transition('running');
        }
        this.transition(terminal);
        for (const id of Object.keys(this.pending)) {
            const entry = this.pending[Number(id)];
            if (entry.timer !== undefined)
                clearTimeout(entry.timer);
            entry.reject(outcome.kind === 'failure'
                ? new ControlCallError(outcome.failure)
                : new ControlCallError({ kind: 'abort', message: `channel recorded its outcome while call ${id} was pending` }));
            this.gate.release(Number(id));
        }
        this.pending = intrinsicObjectCreate(null);
        this.outcomeResolve?.(outcome);
        this.outcomeResolve = undefined;
        this.beginClose();
    }
    beginClose() {
        this.output.end();
        this.graceTimer = setTimeout(() => {
            void (async () => {
                try {
                    await this.forceTerminate?.();
                }
                catch (cause) {
                    this.cleanupErrors[this.cleanupErrors.length] = `forced termination failed: ${errorMessageOf(cause)}`;
                }
            })();
        }, this.limits.closeGraceMs);
        this.checkSettled();
    }
    checkSettled() {
        if (!this.outcomeRecorded)
            return;
        const inputSettled = this.input.readableEnded || this.input.destroyed;
        const outputSettled = this.output.writableFinished || this.output.destroyed;
        if (!inputSettled || !outputSettled)
            return;
        const resolve = this.settleResolve;
        if (resolve === undefined)
            return;
        clearTimeout(this.graceTimer);
        this.graceTimer = undefined;
        this.settleResolve = undefined;
        this.transition('quiescent');
        resolve();
    }
    send(frame) {
        if (this.outcomeRecorded)
            return;
        let encoded;
        let release;
        try {
            encoded = encodeControlFrame(frame, this.limits);
            release = this.sendQueue.reserve(encoded.byteLength);
        }
        catch (cause) {
            if (cause instanceof ControlProtocolError) {
                this.terminate({ kind: 'protocol', message: cause.message }, 'channel-closed');
                return;
            }
            throw cause;
        }
        if (this.state === 'starting')
            this.transition('running');
        this.output.write(encoded, () => {
            release();
        });
        this.checkSettled();
    }
    transition(to) {
        assertControlTransition(this.state, to);
        this.state = to;
    }
}
/** Extract a printable message from an unknown catch value. */
function errorMessageOf(cause) {
    return cause instanceof Error ? cause.message : String(cause);
}
/**
 * Exhaustiveness helper for the closed control-frame union.
 * @param value - the unreachable frame variant.
 * @param context - where the unreachable variant surfaced.
 * @returns never — always throws.
 */
export function assertNever(value, context) {
    const printable = JSON.stringify(value) ?? String(value);
    throw new ControlProtocolError(`unreachable variant in ${context}: ${printable}`);
}
//# sourceMappingURL=transport.js.map