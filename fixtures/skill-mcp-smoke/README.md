# Skill / MCP Smoke Fixtures

These fixtures validate the stage 11/12 Skill and MCP certification path.

They are component test assets, not installable Skill packs:

- `skills/text-echo-declarative` is a safe declarative text Skill fixture.
- `skills/text-transform-brokered` is a brokered script Skill fixture for hash, scanner, trust, and broker policy checks.
- `mcp/mcp-text-tools` is a descriptor-only MCP fixture. It does not start a real MCP server.
- `plugin/text-tools.plugin.json` is a PluginBundle schema fixture. Plugin enable does not grant Skill or MCP capability.

Current automated coverage lives in `deepcode-kernel-skills` tests and is executed through `test.sh`.
Future GUI/TUI certification cards can load the same fixture files for manual review flows.
