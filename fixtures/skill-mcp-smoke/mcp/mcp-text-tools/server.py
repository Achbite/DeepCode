#!/usr/bin/env python3
import json
import sys


def emit(message):
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


for line in sys.stdin:
    if not line.strip():
        continue
    request = json.loads(line)
    method = request.get("method")
    request_id = request.get("id")
    if method == "initialize":
        emit(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "protocolVersion": "2025-06-18",
                    "serverInfo": {
                        "name": "fixture-mcp-text-tools",
                        "version": "1",
                    },
                    "capabilities": {"tools": {}},
                },
            }
        )
    elif method == "tools/call":
        params = request.get("params") or {}
        arguments = params.get("arguments") or {}
        text = str(arguments.get("text", ""))
        emit(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "content": [{"type": "text", "text": text[::-1]}],
                    "isError": False,
                },
            }
        )
    else:
        emit(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32601, "message": f"unsupported method {method}"},
            }
        )
