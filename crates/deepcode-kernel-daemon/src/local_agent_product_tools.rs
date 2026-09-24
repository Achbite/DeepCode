//! Read-only product contributions. Session remains the journal/reducer owner;
//! these executors only adapt registered tool calls to its query port.
use crate::session_service::{SessionServiceError, SessionServiceProcess};
use serde_json::{json, Value};
use std::sync::Arc;

pub(crate) trait SessionReadPort: Send + Sync {
    fn read(&self, query: Value) -> Result<Value, SessionServiceError>;
}

impl SessionReadPort for SessionServiceProcess {
    fn read(&self, query: Value) -> Result<Value, SessionServiceError> {
        self.request("read", query)
    }
}

pub(crate) struct ProductTools {
    reader: Arc<dyn SessionReadPort>,
    plugin_settings: Value,
    pub(crate) document_python: Option<std::path::PathBuf>,
    pub(crate) browser_binding: Option<Value>,
    pub(crate) computer_use_instance: Option<String>,
    pub(crate) container_instance: Option<String>,
    pub(crate) process_instance: Option<String>,
}

impl ProductTools {
    pub(crate) fn new(reader: Arc<dyn SessionReadPort>) -> Self {
        Self {
            reader,
            plugin_settings: json!({}),
            document_python: None,
            browser_binding: None,
            computer_use_instance: None,
            container_instance: None,
            process_instance: None,
        }
    }

    pub(crate) fn with_plugin_settings(mut self, settings: Value) -> Self {
        self.plugin_settings = settings;
        self
    }

    pub(crate) fn with_computer_use(mut self, instance: Option<String>) -> Self {
        self.computer_use_instance = instance;
        self
    }
    pub(crate) fn with_processes(mut self, instance: Option<String>) -> Self {
        self.process_instance = instance;
        self
    }

    pub(crate) fn with_containers(mut self, instance: Option<String>) -> Self {
        self.container_instance = instance;
        self
    }

    pub(crate) fn with_browser_binding(mut self, binding: Option<Value>) -> Self {
        self.browser_binding = binding;
        self
    }

    pub(crate) fn with_document_python(mut self, path: Option<&str>) -> Self {
        self.document_python = path
            .filter(|path| !path.trim().is_empty())
            .map(std::path::PathBuf::from)
            .or_else(|| {
                std::env::var_os("DEEPCODE_DOCUMENT_PYTHON")
                    .filter(|path| !path.is_empty())
                    .map(std::path::PathBuf::from)
            });
        self
    }

    pub(crate) fn call(&self, name: &str, input: Value) -> Result<Value, SessionServiceError> {
        match name {
            "session.read" => self.reader.read(input),
            "skill.read" => read_skill(input),
            "doc.read" => read_doc(input),
            "plugin.search" => {
                let query = input["query"].as_str().unwrap_or("");
                let limit = input["limit"].as_u64().unwrap_or(20) as usize;
                crate::local_agent_plugins::search_plugins(&self.plugin_settings, query, limit)
                    .map_err(|message| {
                        SessionServiceError::new("plugin_catalog_unavailable", message)
                    })
            }
            _ => Err(SessionServiceError::new("tool_not_found", name)),
        }
    }

    pub(crate) fn definitions() -> Vec<(&'static str, String, Value)> {
        vec![
            ("plugin.search", "Discover installed plugins when a task needs unlisted tools. Omit query to list, or use short capability keywords such as browser. Discovery does not load tools. Activate enabled, available results with the Session plugin activation tool; user mentions are optional. Disabled/unavailable results retain their diagnostic status.".into(), json!({
                "type":"object", "additionalProperties":false, "properties":{
                    "query":{"type":"string","maxLength":240},
                    "limit":{"type":"integer","minimum":1,"maximum":50}
                }
            })),
            ("session.read", "Read persisted DeepCode conversation facts without resuming the session. Query directly; no prior Skill read is required. Start with summary; use messages, tools, plans or context for details. view=images lists archived image references. To inspect images from the current session, pass imageIds with exact referenceId/artifactId values; their pixels enter the next visual input. Include all images needed for comparison. imageIds=[] releases current images. before is an exclusive event-sequence cursor; nextBefore continues older items. Excerpts report truncation. A session ID is required.".into(), json!({
                "type":"object", "additionalProperties":false, "required":["sessionId"],
                "properties": {
                    "sessionId":{"type":"string","description":"Exact complete ID from the user or DeepCode. Preserve it verbatim, including prefixes such as session:."},
                    "view":{"type":"string","enum":["summary","messages","tools","plans","context","reasoning","images"]},
                    "imageIds":{"type":"array","maxItems":8,"uniqueItems":true,"items":{"type":"string","minLength":1},"description":"Requires view=images. Exact current-session image references to inspect together. Omit to list references; [] releases pixels. Do not combine with before or limit."},
                    "before":{"type":"integer","minimum":1},
                    "limit":{"type":"integer","minimum":1,"maximum":50},
                    "recordId":{"type":"string","description":"Exact ToolRecord ID; requires view=tools."},
                    "providerRequestId":{"type":"string","description":"Exact Provider request ID; requires view=context or reasoning."},
                    "offset":{"type":"integer","minimum":0,"description":"Character offset for a bounded reasoning page."}
                }
            })),
            ("skill.read", format!("Read a DeepCode product Skill or its reference when guidance is needed. Read only content relevant to the current question. Available: {}. Omit path to read SKILL.md.",
                SKILLS.iter().map(|skill| format!("{} — {}", skill.id, skill.description())).collect::<Vec<_>>().join("; ")), json!({
                "type":"object", "additionalProperties":false, "required":["name"],
                "properties": {
                    "name":{"type":"string","enum": SKILLS.iter().map(|skill| skill.id).collect::<Vec<_>>()},
                    "path":{"type":"string","description":"SKILL.md or a reference path linked by that Skill."}
                }
            })),
            ("doc.read", format!("Read bundled DeepCode product documentation in English Markdown. Docs explain product behavior, configuration and known limitations; Skills describe task workflows. Available documents: {}.", bundled_doc_names().collect::<Vec<_>>().join(", ")), json!({
                "type":"object", "additionalProperties":false, "required":["name"],
                "properties":{"name":{"type":"string","enum":bundled_doc_names().collect::<Vec<_>>()}}
            })),
        ]
    }
}

struct ProductSkill {
    id: &'static str,
    entry: &'static str,
    references: &'static [(&'static str, &'static str)],
}

impl ProductSkill {
    fn description(&self) -> &str {
        self.entry
            .lines()
            .find_map(|line| line.strip_prefix("description: "))
            .expect("bundled Skill has a description")
    }
}

const SKILLS: &[ProductSkill] = &[
    ProductSkill {
        id: "deepcode-session",
        entry: include_str!("../../../skills/deepcode-session/SKILL.md"),
        references: &[(
            "references/session-query.md",
            include_str!("../../../skills/deepcode-session/references/session-query.md"),
        )],
    },
    ProductSkill {
        id: "deepcode-product",
        entry: include_str!("../../../skills/deepcode-product/SKILL.md"),
        references: &[
            (
                "references/operations.md",
                include_str!("../../../skills/deepcode-product/references/operations.md"),
            ),
            (
                "references/windows-environment.md",
                include_str!("../../../skills/deepcode-product/references/windows-environment.md"),
            ),
        ],
    },
    ProductSkill {
        id: "deepcode-iteration",
        entry: include_str!("../../../skills/deepcode-iteration/SKILL.md"),
        references: &[
            (
                "references/implementation-map.md",
                include_str!("../../../skills/deepcode-iteration/references/implementation-map.md"),
            ),
            (
                "references/update-modes.md",
                include_str!("../../../skills/deepcode-iteration/references/update-modes.md"),
            ),
        ],
    },
    ProductSkill {
        id: "deepcode-release-audit",
        entry: include_str!("../../../skills/deepcode-release-audit/SKILL.md"),
        references: &[
            (
                "references/simplification.md",
                include_str!("../../../skills/deepcode-release-audit/references/simplification.md"),
            ),
            (
                "references/product-docs.md",
                include_str!("../../../skills/deepcode-release-audit/references/product-docs.md"),
            ),
        ],
    },
    ProductSkill {
        id: "deepcode-documents",
        entry: include_str!("../../../skills/deepcode-documents/SKILL.md"),
        references: &[
            (
                "references/design.md",
                include_str!("../../../skills/deepcode-documents/references/design.md"),
            ),
            (
                "references/formats.md",
                include_str!("../../../skills/deepcode-documents/references/formats.md"),
            ),
            (
                "assets/document.html",
                include_str!("../../../skills/deepcode-documents/assets/document.html"),
            ),
            (
                "THIRD_PARTY_NOTICES.md",
                include_str!("../../../skills/deepcode-documents/THIRD_PARTY_NOTICES.md"),
            ),
        ],
    },
];

const DOCS: &[(&str, &str)] = &[
    (
        "ui-plugins.md",
        include_str!("../../../docs/product/ui-plugins.md"),
    ),
    (
        "operations.md",
        include_str!("../../../docs/product/operations.md"),
    ),
    (
        "execution-environments.md",
        include_str!("../../../docs/product/execution-environments.md"),
    ),
    (
        "model-services.md",
        include_str!("../../../docs/product/model-services.md"),
    ),
];

pub(crate) fn bundled_doc_names() -> impl Iterator<Item = &'static str> {
    DOCS.iter().map(|(name, _)| *name)
}

fn read_doc(input: Value) -> Result<Value, SessionServiceError> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Query {
        name: String,
    }
    let query: Query = serde_json::from_value(input)
        .map_err(|error| SessionServiceError::new("tool_input_invalid", error.to_string()))?;
    let (_, content) = DOCS
        .iter()
        .find(|(name, _)| *name == query.name)
        .ok_or_else(|| SessionServiceError::new("doc_not_found", &query.name))?;
    Ok(json!({"name":query.name,"mediaType":"text/markdown","content":content}))
}

pub(crate) fn bundled_skill_settings() -> Vec<Value> {
    SKILLS
        .iter()
        .map(|skill| {
            json!({
                "id": skill.id,
                "displayName": if skill.id == "deepcode-documents" { "文档排版" } else { skill.id },
                "description": if skill.id == "deepcode-documents" { "排版并导出 HTML、PDF 和 Markdown。" } else { skill.description() },
                "source": "builtin",
            })
        })
        .collect()
}

fn read_skill(input: Value) -> Result<Value, SessionServiceError> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Query {
        name: String,
        path: Option<String>,
    }
    if input.get("path").is_some_and(|path| !path.is_string()) {
        return Err(SessionServiceError::new(
            "tool_input_invalid",
            "path must be a string",
        ));
    }
    let query: Query = serde_json::from_value(input)
        .map_err(|error| SessionServiceError::new("tool_input_invalid", error.to_string()))?;
    let skill = SKILLS
        .iter()
        .find(|skill| skill.id == query.name)
        .ok_or_else(|| SessionServiceError::new("skill_not_found", &query.name))?;
    let path = query.path.as_deref().unwrap_or("SKILL.md");
    let content = if path == "SKILL.md" {
        skill.entry
    } else {
        skill
            .references
            .iter()
            .find(|(candidate, _)| *candidate == path)
            .map(|(_, content)| *content)
            .ok_or_else(|| SessionServiceError::new("skill_resource_not_found", path))?
    };
    Ok(json!({"name":skill.id,"path":path,"content":content}))
}

#[cfg(test)]
pub(crate) fn test_product_tools() -> Arc<ProductTools> {
    struct Reader;
    impl SessionReadPort for Reader {
        fn read(&self, _: Value) -> Result<Value, SessionServiceError> {
            Err(SessionServiceError::new(
                "session_not_found",
                "No session in this isolated fixture.",
            ))
        }
    }
    Arc::new(ProductTools::new(Arc::new(Reader)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_product_docs_are_discoverable_and_readable() {
        let tools = test_product_tools();
        let definitions = ProductTools::definitions();
        let (_, description, schema) = definitions
            .iter()
            .find(|(name, _, _)| *name == "doc.read")
            .unwrap();
        let names = schema["properties"]["name"]["enum"].as_array().unwrap();
        assert!(names.contains(&json!("model-services.md")));
        let catalog = crate::local_agent_plugins::plugin_catalog_projection(&json!({})).unwrap();
        for name in names {
            assert!(description.contains(name.as_str().unwrap()));
            let reference = json!({"toolName":"doc.read", "name":name});
            let item = catalog["plugins"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["reference"] == reference)
                .unwrap();
            assert_eq!(item["category"], "reference");
            assert_eq!(item["discovery"], "searchOnly");
            assert_eq!(item["available"], true);
            let doc = tools.call("doc.read", json!({"name":name})).unwrap();
            assert_eq!(doc["name"], *name);
            assert_eq!(doc["mediaType"], "text/markdown");
            assert!(doc["content"].as_str().unwrap().starts_with("# "));
        }
        let model_doc = tools
            .call("doc.read", json!({"name":"model-services.md"}))
            .unwrap();
        assert!(model_doc["content"].as_str().unwrap().contains("## Usage"));
        assert!(tools.computer_use_instance.is_none());
    }

    #[test]
    fn plugin_search_discovers_capabilities_without_loading_tools() {
        let tools = test_product_tools();
        let found = tools
            .call("plugin.search", json!({"query":"browser"}))
            .unwrap();
        assert!(found["plugins"].as_array().unwrap().iter().any(|plugin| {
            plugin["uri"] == "plugin://computer-use@builtin" && plugin["enabled"] == true
        }));
        assert!(tools.computer_use_instance.is_none());
    }

    #[test]
    fn product_docs_and_skills_are_distinct_read_only_resources() {
        let tools = test_product_tools();
        let doc = tools
            .call("doc.read", json!({"name":"execution-environments.md"}))
            .unwrap();
        assert_eq!(doc["mediaType"], "text/markdown");
        assert!(doc["content"]
            .as_str()
            .unwrap()
            .contains("## Native Windows"));
        assert!(tools
            .call("skill.read", json!({"name":"execution-environments.md"}))
            .is_err());
        let skill = tools
            .call("skill.read", json!({"name":"deepcode-product"}))
            .unwrap();
        assert!(skill["content"]
            .as_str()
            .unwrap()
            .starts_with("---\nname: deepcode-product"));
        assert!(tools
            .call("doc.read", json!({"name":"../../private.md"}))
            .is_err());
        assert!(tools
            .call("doc.read", json!({"name":"ui-plugins.md"}))
            .unwrap()["content"]
            .as_str()
            .unwrap()
            .contains("apply(context)"));
        for path in [
            "SKILL.md",
            "references/design.md",
            "references/formats.md",
            "assets/document.html",
        ] {
            let resource = tools
                .call(
                    "skill.read",
                    json!({"name":"deepcode-documents", "path":path}),
                )
                .unwrap();
            assert_eq!(resource["path"], path);
            assert!(!resource["content"].as_str().unwrap().is_empty());
        }
    }

    #[test]
    fn development_skills_are_discoverable_read_only_references() {
        let tools = test_product_tools();
        let definitions = ProductTools::definitions();
        let (_, _, schema) = definitions
            .iter()
            .find(|(name, _, _)| *name == "skill.read")
            .unwrap();
        let names = schema["properties"]["name"]["enum"].as_array().unwrap();
        let catalog = crate::local_agent_plugins::plugin_catalog_projection(&json!({})).unwrap();
        for (name, references) in [
            (
                "deepcode-iteration",
                [
                    "references/implementation-map.md",
                    "references/update-modes.md",
                ],
            ),
            (
                "deepcode-release-audit",
                ["references/simplification.md", "references/product-docs.md"],
            ),
        ] {
            assert!(names.contains(&json!(name)));
            let uri = format!("plugin://{name}@builtin");
            let entry = catalog["plugins"]
                .as_array()
                .unwrap()
                .iter()
                .find(|plugin| plugin["uri"] == uri)
                .unwrap();
            assert_eq!(entry["source"], "builtin");
            assert_eq!(entry["contributionKind"], "skill");
            assert_eq!(entry["category"], "reference");
            assert_eq!(entry["discovery"], "searchOnly");
            assert_eq!(entry["enabled"], true);
            assert_eq!(entry["available"], true);
            assert_eq!(
                entry["reference"],
                json!({"toolName":"skill.read", "name":name})
            );
            let skill = tools.call("skill.read", json!({"name":name})).unwrap();
            assert_eq!(skill["name"], name);
            assert_eq!(skill["path"], "SKILL.md");
            assert!(!skill["content"].as_str().unwrap().is_empty());
            for path in references {
                let resource = tools
                    .call("skill.read", json!({"name":name, "path":path}))
                    .unwrap();
                assert_eq!(resource["path"], path);
                assert!(!resource["content"].as_str().unwrap().is_empty());
            }
        }
        assert!(tools.computer_use_instance.is_none());
        assert!(tools.container_instance.is_none());
        assert!(tools.process_instance.is_none());
    }
}
