# Persistent Python kernel for the workspace extension's `python` tool.
# Requests arrive as JSON lines on a private copy of stdin; each cell ends with DONE <id> on stdout and stderr.
import ast
import asyncio
import inspect
import json
import os
import signal
import sys
import traceback

DONE = "\x00pi-python-done"

control = os.fdopen(os.dup(0), "r", encoding="utf-8")
devnull = os.open(os.devnull, os.O_RDONLY)
os.dup2(devnull, 0)
sys.stdin = open(os.devnull, encoding="utf-8")

namespace = {"__name__": "__main__", "__builtins__": __builtins__}
loop = asyncio.new_event_loop()
asyncio.set_event_loop(loop)
FLAGS = ast.PyCF_ALLOW_TOP_LEVEL_AWAIT


def run(code, mode):
    result = eval(compile(code, "<cell>", mode, flags=FLAGS), namespace)
    return loop.run_until_complete(result) if inspect.iscoroutine(result) else result


def cell(source):
    tree = ast.parse(source, "<cell>")
    last = tree.body.pop() if tree.body and isinstance(tree.body[-1], ast.Expr) else None
    run(tree, "exec")
    if last is not None:
        value = run(ast.Expression(last.value), "eval")
        if value is not None:
            namespace["_"] = value
            print(repr(value))


# An interrupt that lands between cells must not kill the kernel.
signal.signal(signal.SIGINT, signal.SIG_IGN)
for line in control:
    request = json.loads(line)
    ok = True
    try:
        signal.signal(signal.SIGINT, signal.default_int_handler)
        cell(request["code"])
    except BaseException as error:
        ok = False
        if isinstance(error, SystemExit):
            print(f"SystemExit({error.code!r}) caught; the kernel keeps running.", file=sys.stderr)
        else:
            traceback.print_exc()
    finally:
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        sys.stderr.write(f"\n{DONE} {request['id']}\n")
        sys.stderr.flush()
        sys.stdout.write(f"\n{DONE} {request['id']} {json.dumps({'ok': ok})}\n")
        sys.stdout.flush()
