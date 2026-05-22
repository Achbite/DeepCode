Load prompt, ruler, and skill metadata before creating an execution plan.

```deepcode-action
{
  "version": 1,
  "mode": "plan",
  "actions": [
    {
      "type": "fs.list",
      "path": ".",
      "depth": 2
    },
    {
      "type": "final",
      "content": "Prompt layers and skill references should be loaded through dedicated endpoints."
    }
  ]
}
```
