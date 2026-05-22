Agent should run this only after explicit approval in askBeforeWrite mode.

```deepcode-action
{
  "version": 1,
  "actions": [
    {
      "type": "shell.exec",
      "command": "echo deepcode-agent-shell",
      "timeoutMs": 5000,
      "reason": "Verify isolated Agent temporary shell execution."
    }
  ]
}
```
