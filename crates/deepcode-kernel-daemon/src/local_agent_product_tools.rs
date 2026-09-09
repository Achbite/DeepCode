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
}

impl ProductTools {
    pub(crate) fn new(reader: Arc<dyn SessionReadPort>) -> Self {
        Self { reader }
    }

    pub(crate) fn call(&self, name: &str, input: Value) -> Result<Value, SessionServiceError> {
        match name {
            "session.read" => self.reader.read(input),
            "skill.read" => read_skill(input),
            _ => Err(SessionServiceError::new("tool_not_found", name)),
        }
    }

    pub(crate) fn definitions() -> Vec<(&'static str, String, Value)> {
        vec![
            ("session.read", "Read persisted DeepCode conversation facts without resuming the session. Query directly; no prior Skill read is required. Start with summary; use messages, tools, plans or context for details. before is an exclusive event-sequence cursor; nextBefore continues older items. Excerpts report truncation. A session ID is required.".into(), json!({
                "type":"object", "additionalProperties":false, "required":["sessionId"],
                "properties": {
                    "sessionId":{"type":"string","description":"Exact complete ID from the user or DeepCode. Preserve it verbatim, including prefixes such as session:."},
                    "view":{"type":"string","enum":["summary","messages","tools","plans","context","reasoning"]},
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
        references: &[(
            "references/operations.md",
            include_str!("../../../skills/deepcode-product/references/operations.md"),
        )],
    },
];

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
