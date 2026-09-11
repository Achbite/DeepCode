use serde_json::{json, Value};

pub(crate) fn core_tool_prompt_providers() -> Value {
    json!([{
        "providerRef": "tool-prompt-provider:core-builtin",
        "origin": "coreBuiltin",
        "contributions": [
            {
                "contributionRef": "tool-prompt-contribution:core:fs.read",
                "canonicalToolName": "fs.read",
                "promptSnippet": "Read UTF-8 workspace text directly or in bounded segments.",
                "usageGuidelines": [
                    "Use this to inspect the contents of a known workspace text file instead of shell commands such as cat or sed.",
                    "Use startLine and maxLines for a line range; startByte and maxBytes for byte bounds."
                ]
            },
            {
                "contributionRef": "tool-prompt-contribution:core:bash",
                "canonicalToolName": "bash",
                "promptSnippet": "List, search, discover, build, test, and run commands.",
                "usageGuidelines": [
                    "Use this for discovery, search, builds and commands. 检查命令独立执行；需要追加报告时，先保存退出码、最后 exit 原退出码。预期文件不存在用条件分支；管道中需要保留的失败用 pipefail 传播。",
                    "Do not use this as the default way to read a known UTF-8 workspace text file.",
                    "Use the project's declared build/test scripts in their required environment. Finding docker or another executable does not establish service availability; use an actual permitted service check and report its error.",
                    "A Plan denial means this call was not executed. Stay within confirmed targets and executionScope; routine command details do not require reconfirmation. Revise the Plan only when the authorized scope must change.",
                    "Output is limited to the last 2000 lines or 50 KiB. When truncated, fullOutput contains Session-owned log paths; inspect bounded sections with a read-only Bash command instead of repeating the original command."
                ]
            },
            {
                "contributionRef": "tool-prompt-contribution:core:web.fetch",
                "canonicalToolName": "web.fetch",
                "promptSnippet": "Read bounded text from a known HTTP or HTTPS URL.",
                "usageGuidelines": [
                    "Read URLs supplied by the user or returned by search."
                ]
            },
            {
                "contributionRef": "tool-prompt-contribution:core:web.search",
                "canonicalToolName": "web.search",
                "promptSnippet": "Search the web by keyword.",
                "usageGuidelines": [
                    "Cite returned sources and report search errors."
                ]
            }
        ]
    }])
}

pub(crate) fn run_tool_prompt_providers(
    selection: &crate::local_agent_plugins::ResolvedPluginSelection,
) -> Value {
    let mut providers = core_tool_prompt_providers()
        .as_array()
        .expect("core tool prompt providers are an array")
        .clone();
    providers.extend(selection.extension_tool_prompt_providers());
    Value::Array(providers)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_prompt_provider_has_distinct_tool_guidance() {
        let providers = core_tool_prompt_providers();
        let providers = providers.as_array().expect("provider array");
        assert_eq!(providers.len(), 1);
        let contributions = providers[0]["contributions"]
            .as_array()
            .expect("contribution array");
        assert_eq!(
            contributions
                .iter()
                .map(|item| item["canonicalToolName"].as_str().expect("tool name"))
                .collect::<Vec<_>>(),
            vec!["fs.read", "bash", "web.fetch", "web.search"]
        );
        assert!(contributions
            .iter()
            .all(|contribution| contribution["usageGuidelines"]
                .as_array()
                .expect("guidelines")
                .iter()
                .all(|guideline| {
                    let guideline = guideline.as_str().expect("guideline text");
                    ["fs.read", "bash", "web.fetch", "web.search"]
                        .iter()
                        .all(|tool_name| !guideline.contains(tool_name))
                })));
        assert!(contributions[0]["usageGuidelines"][0]
            .as_str()
            .expect("read guideline")
            .contains("instead of shell commands such as cat or sed"));
        assert!(contributions[1]["usageGuidelines"][1]
            .as_str()
            .expect("bash guideline")
            .contains("not use this as the default way to read"));
        assert!(contributions[2]["usageGuidelines"][0]
            .as_str()
            .expect("fetch guideline")
            .contains("supplied by the user or returned by search"));
        assert!(contributions[3]["usageGuidelines"][0]
            .as_str()
            .expect("fetch guideline")
            .contains("Cite returned sources and report search errors"));
    }
}
