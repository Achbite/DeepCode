import json
import sys


def main() -> int:
    payload = json.load(sys.stdin)
    text = str(payload.get("text", ""))
    json.dump({"text": text.upper()}, sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
