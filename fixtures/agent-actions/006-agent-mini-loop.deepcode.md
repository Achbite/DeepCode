The Agent should follow this as a minimal local reasoning loop:
read the package manifest, search for the Kernel Web Host tool endpoint,
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
      "query": "agent_tools",
      "include": ["crates/deepcode-host-web/src"]
    },
    {
      "type": "shell.propose",
      "command": "cargo check -p deepcode-host-web",
      "cwd": ".",
      "reason": "Verify Kernel Web Host protocol changes without executing automatically.",
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
