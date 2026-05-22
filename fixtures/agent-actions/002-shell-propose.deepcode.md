Propose a safe verification command. Do not execute it automatically.

```deepcode-action
{
  "version": 1,
  "mode": "plan",
  "actions": [
    {
      "type": "shell.propose",
      "command": "pnpm --filter @deepcode/server typecheck",
      "cwd": ".",
      "reason": "Verify server TypeScript after Agent protocol changes.",
      "risk": "low"
    }
  ]
}
```
