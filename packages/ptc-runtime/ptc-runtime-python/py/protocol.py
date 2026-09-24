"""Typed mirror of the fd-3 JSON-lines protocol in ``src/protocol.ts``."""

from __future__ import annotations

from typing import Any, Literal, TypedDict, Union

PROTOCOL_FD = 3


class ErrorClass(TypedDict):
    name: str
    memberNameProperty: str


_NamespaceRequired = TypedDict("_NamespaceRequired", {"global": str, "names": "list[str]"})


class Namespace(_NamespaceRequired, total=False):
    errorClass: ErrorClass


class BootMessage(TypedDict):
    type: Literal["boot"]
    cpuSeconds: int
    addressSpaceBytes: int
    maxOutputBytes: int
    maxControlBytes: int
    namespaces: "list[Namespace]"


class RunMessage(TypedDict):
    type: Literal["run"]
    program: str


class BootAckMessage(TypedDict):
    type: Literal["boot-ack"]


CallMessage = TypedDict(
    "CallMessage",
    {"type": Literal["call"], "id": int, "global": str, "name": str, "args": Any},
)


class LogMessage(TypedDict):
    type: Literal["log"]
    text: str


class DoneErrorField(TypedDict):
    kind: Literal["exception", "invalid-output", "output-limit"]
    message: str


_DoneMessageRequired = TypedDict("_DoneMessageRequired", {"type": Literal["done"]})


class DoneMessage(_DoneMessageRequired, total=False):
    value: Any
    error: DoneErrorField


ChildToHost = Union[BootAckMessage, CallMessage, LogMessage, DoneMessage]


class ReplyOk(TypedDict):
    type: Literal["reply"]
    id: int
    ok: Literal[True]
    value: Any


class ReplyErr(TypedDict):
    type: Literal["reply"]
    id: int
    ok: Literal[False]
    message: str


ReplyMessage = Union[ReplyOk, ReplyErr]
HostToChild = Union[BootMessage, RunMessage, ReplyMessage]
