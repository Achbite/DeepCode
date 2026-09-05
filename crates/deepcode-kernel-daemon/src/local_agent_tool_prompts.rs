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
                    "Use offset and limit when only a bounded segment is needed."
                ]
            },
            {
                "contributionRef": "tool-prompt-contribution:core:bash",
                "canonicalToolName": "bash",
                "promptSnippet": "List, search, discover, build, test, and run commands.",
                "usageGuidelines": [
                    "Use this for directory listing, text search, file discovery, builds, tests, and command execution.",
                    "Do not use this as the default way to read a known UTF-8 workspace text file."
                ]
            },
            {
                "contributionRef": "tool-prompt-contribution:core:web.fetch",
                "canonicalToolName": "web.fetch",
                "promptSnippet": "Read bounded text from a known HTTP or HTTPS URL.",
                "usageGuidelines": [
                    "Use this to inspect a URL supplied by the user or returned by an earlier tool result.",
                    "Do not use this as a substitute for unavailable search by guessing URLs or selecting general-purpose websites; report that search is unavailable instead."
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
            vec!["fs.read", "bash", "web.fetch"]
        );
        assert!(contributions
            .iter()
            .all(|contribution| contribution["usageGuidelines"]
                .as_array()
                .expect("guidelines")
                .iter()
                .all(|guideline| {
                    let guideline = guideline.as_str().expect("guideline text");
                    ["fs.read", "bash", "web.fetch"]
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
            .contains("supplied by the user or returned by an earlier tool result"));
        assert!(contributions[2]["usageGuidelines"][1]
            .as_str()
            .expect("fetch guideline")
            .contains("not use this as a substitute for unavailable search"));
    }
}
