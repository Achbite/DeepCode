The Agent should follow this as a minimal local reasoning loop:
read the package manifest, search for the Agent tool route registration,
propose a safe verification command, prepare a patch plan, and then summarize.

```deepcode-action
{
  "version": 1,
  "mode": "plan",
  "actions": [
    {
      "type": "fs.read",
      "path": "package.json"
    },
    {
      "type": "code.search",
      "query": "registerAgentToolRoutes",
      "include": ["server/src"]
    },
    {
      "type": "shell.propose",
      "command": "pnpm --filter @deepcode/server typecheck",
      "cwd": ".",
      "reason": "Verify server-side Agent protocol changes without executing automatically.",
      "risk": "low"
    },
    {
      "type": "patch.plan",
      "path": "README.md",
      "startLine": 1,
      "endLine": 1,
      "oldTextSha256": "fixture",
      "newText": "# DeepCode"
    },
    {
      "type": "final",
      "content": "Mini loop completed: read, search, proposed command, queued patch."
    }
  ]
}
```
