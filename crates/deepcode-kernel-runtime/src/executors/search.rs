use super::*;

pub(super) struct FsGlobExecutor;
pub(super) struct CodeGrepExecutor;

impl SkillExecutor for FsGlobExecutor {
    fn descriptor(&self) -> SkillDescriptor {
        descriptor("fs.glob")
    }

    fn invoke(
        &self,
        invocation: SkillInvocation,
        context: SkillExecutionContext,
    ) -> KernelResult<SkillResult> {
        let root = workspace_root(&context)?;
        let relative = get_string(&invocation.input, "path").unwrap_or_else(|| ".".to_string());
        let target = resolve_workspace_read_path(&root, &relative)?;
        if !target.is_dir() {
            return Err(KernelError::InvalidCommand(format!(
                "fs.glob path is not a directory: {relative}"
            )));
        }
        let pattern = required_string(&invocation.input, "pattern")?;
        let matcher = glob_regex(&pattern)?;
        let max_results = invocation
            .input
            .get("maxResults")
            .and_then(Value::as_u64)
            .unwrap_or(500)
            .clamp(1, 5_000) as usize;
        let mut matches = Vec::new();
        let mut skipped = 0usize;
        collect_glob_matches(
            &root,
            &target,
            &matcher,
            max_results,
            &mut matches,
            &mut skipped,
        )?;
        let truncated = matches.len() >= max_results;
        Ok(ok(
            invocation.id,
            serde_json::json!({
                "path": normalize_relative_path(&relative),
                "pattern": pattern,
                "matches": matches,
                "truncated": truncated,
                "skippedEntries": skipped
            }),
        ))
    }
}

impl SkillExecutor for CodeGrepExecutor {
    fn descriptor(&self) -> SkillDescriptor {
        descriptor("code.grep")
    }

    fn invoke(
        &self,
        invocation: SkillInvocation,
        context: SkillExecutionContext,
    ) -> KernelResult<SkillResult> {
        let root = workspace_root(&context)?;
        let query = get_string(&invocation.input, "query").unwrap_or_default();
        if query.trim().is_empty() {
            return Err(KernelError::InvalidCommand(
                "search query is required".to_string(),
            ));
        }
        let includes = string_array(&invocation.input, "include");
        let excludes = string_array(&invocation.input, "exclude");
        let strategy =
            get_string(&invocation.input, "strategy").unwrap_or_else(|| "literal".to_string());
        let relative = get_string(&invocation.input, "path").unwrap_or_else(|| ".".to_string());
        let target = resolve_workspace_read_path(&root, &relative)?;
        if !target.is_dir() {
            return Err(KernelError::InvalidCommand(format!(
                "code.grep path is not a directory: {relative}"
            )));
        }
        let context_lines = invocation
            .input
            .get("contextLines")
            .and_then(Value::as_u64)
            .unwrap_or(0) as u32;
        let max_results = invocation
            .input
            .get("maxResults")
            .and_then(Value::as_u64)
            .unwrap_or(CODE_SEARCH_DEFAULT_MAX_RESULTS as u64) as u32;
        let result = grep_workspace_with_options(
            &root,
            &target,
            CodeGrepOptions {
                query: &query,
                strategy: &strategy,
                includes: &includes,
                excludes: &excludes,
                context_lines,
                max_results,
            },
        )?;
        let returned_matches = result.matches.len();
        Ok(ok(
            invocation.id,
            serde_json::json!({
                "folderId": "wf-0",
                "query": query,
                "path": normalize_relative_path(&relative),
                "strategy": strategy,
                "include": includes,
                "exclude": excludes,
                "contextLines": result.context_lines,
                "maxResults": result.max_results,
                "returnedMatches": returned_matches,
                "truncated": result.truncated,
                "visitedFiles": result.visited_files,
                "skippedFiles": result.skipped_files,
                "skippedBinaryFiles": result.skipped_binary_files,
                "skippedExecutableFiles": result.skipped_executable_files,
                "matches": result.matches
            }),
        ))
    }
}

pub(crate) struct CodeGrepResult {
    pub(crate) matches: Vec<Value>,
    pub(crate) truncated: bool,
    pub(crate) context_lines: usize,
    pub(crate) max_results: usize,
    pub(crate) visited_files: usize,
    pub(crate) skipped_files: usize,
    pub(crate) skipped_binary_files: usize,
    pub(crate) skipped_executable_files: usize,
}

enum TextMatcher {
    Literal(String),
    Regex(Regex),
}

impl TextMatcher {
    fn is_match(&self, value: &str) -> bool {
        match self {
            Self::Literal(needle) => value.contains(needle),
            Self::Regex(regex) => regex.is_match(value),
        }
    }
}

pub(crate) struct CodeGrepOptions<'a> {
    pub(crate) query: &'a str,
    pub(crate) strategy: &'a str,
    pub(crate) includes: &'a [String],
    pub(crate) excludes: &'a [String],
    pub(crate) context_lines: u32,
    pub(crate) max_results: u32,
}

pub(crate) fn grep_workspace_with_options(
    root: &Path,
    target: &Path,
    options: CodeGrepOptions<'_>,
) -> KernelResult<CodeGrepResult> {
    let matcher = match options.strategy {
        "literal" => TextMatcher::Literal(options.query.to_string()),
        "regex" => TextMatcher::Regex(Regex::new(options.query).map_err(|error| {
            KernelError::InvalidCommand(format!("code.grep invalid regex: {error}"))
        })?),
        other => {
            return Err(KernelError::InvalidCommand(format!(
                "code.grep unsupported strategy: {other}"
            )))
        }
    };
    let include_patterns = compile_glob_patterns(options.includes)?;
    let exclude_patterns = compile_glob_patterns(options.excludes)?;
    let context_lines = (options.context_lines as usize).min(CODE_SEARCH_MAX_CONTEXT_LINES);
    let max_results = (options.max_results as usize).clamp(1, CODE_SEARCH_MAX_RESULTS);
    let mut traversal = SearchTraversal {
        root,
        matcher: &matcher,
        includes: &include_patterns,
        excludes: &exclude_patterns,
        context_lines,
        max_results,
        visited_files: 0,
        skipped_files: 0,
        skipped_binary_files: 0,
        skipped_executable_files: 0,
        matches: Vec::new(),
    };
    let truncated = traversal.search_dir(target)?;
    Ok(CodeGrepResult {
        matches: traversal.matches,
        truncated,
        context_lines,
        max_results,
        visited_files: traversal.visited_files,
        skipped_files: traversal.skipped_files,
        skipped_binary_files: traversal.skipped_binary_files,
        skipped_executable_files: traversal.skipped_executable_files,
    })
}

struct SearchTraversal<'a> {
    root: &'a Path,
    matcher: &'a TextMatcher,
    includes: &'a [Regex],
    excludes: &'a [Regex],
    context_lines: usize,
    max_results: usize,
    visited_files: usize,
    skipped_files: usize,
    skipped_binary_files: usize,
    skipped_executable_files: usize,
    matches: Vec<Value>,
}

impl SearchTraversal<'_> {
    fn search_dir(&mut self, dir: &Path) -> KernelResult<bool> {
        for entry in fs::read_dir(dir)
            .map_err(|error| KernelError::Other(format!("search {}: {error}", dir.display())))?
        {
            let entry =
                entry.map_err(|error| KernelError::Other(format!("search entry: {error}")))?;
            let path = entry.path();
            if path.is_dir() {
                if skip_directory(&path) {
                    continue;
                }
                if self.search_dir(&path)? {
                    return Ok(true);
                }
                continue;
            }
            if !path.is_file() {
                continue;
            }
            let relative = path
                .strip_prefix(self.root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            if !self.includes.is_empty()
                && !self
                    .includes
                    .iter()
                    .any(|pattern| pattern.is_match(&relative))
            {
                continue;
            }
            if self
                .excludes
                .iter()
                .any(|pattern| pattern.is_match(&relative))
            {
                continue;
            }
            self.visited_files += 1;
            if self.visited_files > CODE_SEARCH_MAX_VISITED_FILES {
                return Ok(true);
            }
            let content = match read_text_file_for_llm(&path) {
                Ok(read) => read.content,
                Err(skip) => {
                    self.skipped_files += 1;
                    if skip.classification.binary {
                        self.skipped_binary_files += 1;
                    }
                    if skip.classification.executable {
                        self.skipped_executable_files += 1;
                    }
                    continue;
                }
            };
            let lines = content.lines().collect::<Vec<_>>();
            for (line_index, line) in lines.iter().enumerate() {
                if self.matcher.is_match(line) {
                    let mut item = serde_json::json!({
                        "path": relative,
                        "line": line_index + 1,
                        "preview": line
                    });
                    if self.context_lines > 0 {
                        if let Some(record) = item.as_object_mut() {
                            let before_start = line_index.saturating_sub(self.context_lines);
                            let before = (before_start..line_index)
                                .map(|index| {
                                    serde_json::json!({
                                        "line": index + 1,
                                        "text": lines[index]
                                    })
                                })
                                .collect::<Vec<_>>();
                            let after_end = (line_index + 1 + self.context_lines).min(lines.len());
                            let after = (line_index + 1..after_end)
                                .map(|index| {
                                    serde_json::json!({
                                        "line": index + 1,
                                        "text": lines[index]
                                    })
                                })
                                .collect::<Vec<_>>();
                            record.insert("before".to_string(), Value::Array(before));
                            record.insert("after".to_string(), Value::Array(after));
                        }
                    }
                    self.matches.push(item);
                    if self.matches.len() >= self.max_results {
                        return Ok(true);
                    }
                }
            }
        }
        Ok(false)
    }
}

pub(super) fn skip_directory(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(OsStr::to_str),
        Some(".git" | "node_modules" | "target" | ".pnpm-store")
    )
}
