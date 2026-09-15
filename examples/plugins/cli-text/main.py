"""Single-file CLI contribution. No server or external dependency is required."""
import json
import sys

request = json.load(sys.stdin)
text = request.get("arguments", {}).get("text")
if request.get("name") != "count" or not isinstance(text, str):
    result = {"error": {"code": "invalid_input", "message": "count requires a text argument"}}
else:
    result = {"characters": len(text), "words": len(text.split()), "lines": len(text.splitlines())}
json.dump(result, sys.stdout, ensure_ascii=False)
