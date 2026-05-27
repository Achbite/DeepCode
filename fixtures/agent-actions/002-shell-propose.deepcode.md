Propose a safe verification command. Do not execute it automatically.

```deepcode-action
{
  "version": 1,
  "mode": "plan",
  "actions": [
    {
      "type": "shell.propose",
      "command": "cargo check -p deepcode-host-web",
      "cwd": ".",
      "reason": "Verify the Rust Kernel Web Host after Agent protocol changes.",
      "risk": "low"
    }
  ]
}
```
