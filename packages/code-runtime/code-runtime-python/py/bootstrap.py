"""Standard-library bootstrap for one PythonCodeRuntime subprocess."""

from __future__ import annotations

import asyncio
import builtins
import io
import json
import math
import os
import re
import sys
import threading
import textwrap
from typing import Any

sys.setrecursionlimit(max(sys.getrecursionlimit(), 20_000))

_PY_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _PY_DIR)
from protocol import PROTOCOL_FD  # noqa: E402
sys.path.pop(0)
del _PY_DIR
os.environ.clear()

_read_channel = sys.stdin.buffer
sys.stdin = io.StringIO()
_write_channel = os.fdopen(PROTOCOL_FD, "wb", buffering=0, closefd=False)
_write_lock = threading.Lock()


class _OutputLimit(BaseException):
    pass


class _BindingFailure(Exception):
    pass


def _json_safe(value: Any) -> bool:
    """Validate the exact JSON subset Node can receive without numeric loss."""
    active: set[int] = set()
    cursors: list[tuple[Any, int | None]] = [(iter((value,)), None)]
    while cursors:
        cursor, marker = cursors[-1]
        try:
            current = next(cursor)
        except StopIteration:
            cursors.pop()
            if marker is not None:
                active.remove(marker)
            continue
        current_type = type(current)
        if current is None or current_type in (str, bool):
            continue
        if current_type is int:
            try:
                converted = float(current)
            except OverflowError:
                return False
            if not math.isfinite(converted) or int(converted) != current:
                return False
            continue
        if current_type is float:
            if not math.isfinite(current) or (current == 0.0 and math.copysign(1.0, current) < 0):
                return False
            continue
        if current_type is list:
            marker = id(current)
            if marker in active:
                return False
            active.add(marker)
            cursors.append((iter(current), marker))
            continue
        if current_type is dict:
            if any(type(key) is not str for key in current):
                return False
            marker = id(current)
            if marker in active:
                return False
            active.add(marker)
            cursors.append((iter(current.values()), marker))
            continue
        return False
    return True


def _quote(text: str) -> str:
    rendered = json.dumps(text, ensure_ascii=False)
    return "".join(f"\\u{ord(character):04x}" if 0xD800 <= ord(character) <= 0xDFFF else character for character in rendered)


def _encode(value: Any) -> bytes:
    """Encode validated JSON iteratively so deep values remain transferable."""
    chunks: list[str] = []
    tasks: list[tuple[bool, Any]] = [(False, value)]
    while tasks:
        literal, current = tasks.pop()
        if literal:
            chunks.append(current)
        elif type(current) is str:
            chunks.append(_quote(current))
        elif current is None:
            chunks.append("null")
        elif current is True:
            chunks.append("true")
        elif current is False:
            chunks.append("false")
        elif type(current) in (int, float):
            chunks.append(str(current))
        elif type(current) is list:
            chunks.append("[")
            tasks.append((True, "]"))
            for index in range(len(current) - 1, -1, -1):
                if index < len(current) - 1:
                    tasks.append((True, ","))
                tasks.append((False, current[index]))
        elif type(current) is dict:
            keys = list(current)
            chunks.append("{")
            tasks.append((True, "}"))
            for index in range(len(keys) - 1, -1, -1):
                key = keys[index]
                if index < len(keys) - 1:
                    tasks.append((True, ","))
                tasks.append((False, current[key]))
                tasks.append((True, _quote(key) + ":"))
        else:
            raise TypeError("value is not lossless JSON")
    return "".join(chunks).encode("utf-8")


def _send(frame: dict[str, Any], max_bytes: int | None = None) -> None:
    payload = _encode(frame) + b"\n"
    if max_bytes is not None and len(payload) > max_bytes:
        raise _OutputLimit()
    with _write_lock:
        _write_channel.write(payload)


def _read(limit: int) -> dict[str, Any]:
    line = _read_channel.readline(limit + 1)
    if not line or len(line) > limit or not line.endswith(b"\n"):
        raise RuntimeError("invalid host control frame")
    value = json.loads(line)
    if not isinstance(value, dict):
        raise RuntimeError("invalid host control frame")
    return value


def _apply_resource_limits(boot: dict[str, Any]) -> None:
    try:
        import resource
    except ImportError:
        return

    def set_limit(resource_id: int, requested: int, hard_grace: int = 0) -> None:
        _soft, hard = resource.getrlimit(resource_id)
        requested_hard = requested + hard_grace
        target_hard = requested_hard if hard == resource.RLIM_INFINITY else min(requested_hard, hard)
        target_soft = min(requested, target_hard)
        resource.setrlimit(resource_id, (target_soft, target_hard))

    if hasattr(resource, "RLIMIT_CPU"):
        set_limit(resource.RLIMIT_CPU, int(boot["cpuSeconds"]), 1)
    if hasattr(resource, "RLIMIT_AS"):
        set_limit(resource.RLIMIT_AS, int(boot["addressSpaceBytes"]))
    if hasattr(resource, "RLIMIT_CORE"):
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


_PATH = re.compile(r"(?<![A-Za-z0-9_.-])(?:/[A-Za-z0-9_.~@%+,:=-]+)+|[A-Za-z]:\\[^\s]+")


def _safe_exception(error: BaseException) -> str:
    message = _PATH.sub("<path>", str(error)).replace("\x00", "")
    label = type(error).__name__
    return f"{label}: {message}"[:4096] if message else label


class _LogStream(io.TextIOBase):
    def __init__(self, max_output_bytes: int, max_control_bytes: int) -> None:
        self._remaining = max_output_bytes
        self._max_control_bytes = max_control_bytes
        self._ledger_lock = threading.Lock()

    @property
    def encoding(self) -> str:
        return "utf-8"

    def writable(self) -> bool:
        return True

    def write(self, text: str) -> int:
        if not isinstance(text, str):
            raise TypeError("write() argument must be str")
        size = len(text.encode("utf-8"))
        with self._ledger_lock:
            if size > self._remaining:
                raise _OutputLimit()
            _send({"type": "log", "text": text}, self._max_control_bytes)
            self._remaining -= size
        return len(text)

    def flush(self) -> None:
        return None


class _Console:
    def __init__(self, stream: _LogStream) -> None:
        self._stream = stream

    def _write(self, *values: Any) -> None:
        self._stream.write(" ".join(str(value) for value in values))

    log = _write
    warn = _write
    error = _write


class _Bridge:
    def __init__(self, loop: asyncio.AbstractEventLoop, max_control_bytes: int) -> None:
        self._loop = loop
        self._max_control_bytes = max_control_bytes
        self._next_id = 0
        self._pending: dict[int, asyncio.Future[Any]] = {}
        self._reader = threading.Thread(target=self._read_replies, daemon=True, name="dsh-python-replies")
        self._reader.start()

    async def call(self, global_name: str, member_name: str, args: Any, error_class: type[Exception] | None, member_property: str | None) -> Any:
        if not _json_safe(args):
            raise self._failure(error_class, member_property, member_name, "binding arguments must be lossless JSON")
        call_id = self._next_id
        self._next_id += 1
        future = self._loop.create_future()
        self._pending[call_id] = future
        try:
            _send({"type": "call", "id": call_id, "global": global_name, "name": member_name, "args": args}, self._max_control_bytes)
            return await future
        except _OutputLimit:
            self._pending.pop(call_id, None)
            raise self._failure(error_class, member_property, member_name, "binding payload exceeded control limit") from None
        except _BindingFailure as error:
            raise self._failure(error_class, member_property, member_name, str(error)) from None

    @staticmethod
    def _failure(error_class: type[Exception] | None, member_property: str | None, member_name: str, message: str) -> Exception:
        error = (error_class or _BindingFailure)(message)
        if member_property is not None:
            setattr(error, member_property, member_name)
        return error

    def _read_replies(self) -> None:
        while True:
            try:
                frame = _read(self._max_control_bytes)
            except BaseException:
                self._loop.call_soon_threadsafe(self._fail_pending)
                return
            if frame.get("type") != "reply" or not isinstance(frame.get("id"), int):
                continue
            call_id = frame["id"]
            self._loop.call_soon_threadsafe(self._settle, call_id, frame)

    def _settle(self, call_id: int, frame: dict[str, Any]) -> None:
        future = self._pending.pop(call_id, None)
        if future is None or future.done():
            return
        if frame.get("ok") is True and "value" in frame and _json_safe(frame["value"]):
            future.set_result(frame["value"])
        elif frame.get("ok") is False and isinstance(frame.get("message"), str):
            future.set_exception(_BindingFailure(frame["message"]))
        else:
            future.set_exception(_BindingFailure("invalid binding reply"))

    def _fail_pending(self) -> None:
        for future in self._pending.values():
            if not future.done():
                future.set_exception(_BindingFailure("binding channel closed"))
        self._pending.clear()


class _BindingNamespace:
    def __init__(self, members: dict[str, Any]) -> None:
        object.__setattr__(self, "_dsh_members", members)

    def __getattribute__(self, name: str) -> Any:
        members = object.__getattribute__(self, "_dsh_members")
        if name in members:
            return members[name]
        return object.__getattribute__(self, name)

    def __getitem__(self, name: str) -> Any:
        return object.__getattribute__(self, "_dsh_members")[name]


async def _execute(boot: dict[str, Any], run: dict[str, Any]) -> None:
    max_output = int(boot["maxOutputBytes"])
    max_control = int(boot["maxControlBytes"])
    stream = _LogStream(max_output, max_control)
    sys.stdout = stream
    sys.stderr = stream

    loop = asyncio.get_running_loop()
    bridge = _Bridge(loop, max_control)
    globals_map: dict[str, Any] = {
        "__builtins__": builtins,
        "__name__": "__dsh_model__",
        "console": _Console(stream),
    }

    for namespace in boot["namespaces"]:
        descriptor = namespace.get("errorClass")
        error_class = type(descriptor["name"], (Exception,), {}) if descriptor else None
        member_property = descriptor["memberNameProperty"] if descriptor else None
        if error_class is not None:
            globals_map[descriptor["name"]] = error_class
        members: dict[str, Any] = {}
        for member_name in namespace["names"]:
            async def invoke(args: Any, *, _global: str = namespace["global"], _member: str = member_name, _error: type[Exception] | None = error_class, _property: str | None = member_property) -> Any:
                return await bridge.call(_global, _member, args, _error, _property)
            members[member_name] = invoke
        globals_map[namespace["global"]] = _BindingNamespace(members)

    program = run["program"]
    body = textwrap.indent(program, "    ") if program.strip() else "    pass"
    source = f"async def __dsh_main__():\n{body}\n"
    try:
        exec(compile(source, "<model-code>", "exec"), globals_map)
        value = await globals_map["__dsh_main__"]()
        if not _json_safe(value):
            _send({"type": "done", "error": {"kind": "invalid-output", "message": "program completion must be lossless JSON"}}, max_control)
            return
        encoded_value = _encode(value)
        if len(encoded_value) > max_output:
            raise _OutputLimit()
        _send({"type": "done", "value": value}, max_control)
    except _OutputLimit:
        _send({"type": "done", "error": {"kind": "output-limit", "message": f"outer output exceeded {max_output} bytes"}}, max_control)
    except BaseException as error:
        _send({"type": "done", "error": {"kind": "exception", "message": _safe_exception(error)}}, max_control)


def _main() -> None:
    boot = _read(2_147_483_647)
    if boot.get("type") != "boot":
        raise RuntimeError("missing boot frame")
    max_control = int(boot["maxControlBytes"])
    if sys.version_info < (3, 10):
        _send({"type": "boot-ack"}, max_control)
        _read(max_control)
        _send({"type": "done", "error": {"kind": "exception", "message": "Python 3.10 or newer is required"}}, max_control)
        return
    _apply_resource_limits(boot)
    _send({"type": "boot-ack"}, max_control)
    run = _read(max_control)
    if run.get("type") != "run" or not isinstance(run.get("program"), str):
        raise RuntimeError("missing run frame")
    asyncio.run(_execute(boot, run))


if __name__ == "__main__":
    try:
        _main()
    except BaseException:
        # Host observes startup/protocol failure as a sanitized process outcome.
        pass
