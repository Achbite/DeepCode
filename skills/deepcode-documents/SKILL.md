---
name: deepcode-documents
description: Beautify and typeset documents for HTML, PDF or Markdown delivery when the user asks for a polished report, brief, guide, resume or other formatted document.
---

# Document composition

Use this skill when the deliverable is a formatted document. Preserve the user's content, language, audience and chosen format. Ordinary conversation replies do not need a document export.

Read resources with `skill.read`, name `deepcode-documents`, and the relative path below:

- `references/design.md`: typography, spacing, tables and print layout inspired by Kami.
- `references/formats.md`: choose HTML, PDF or Markdown and use the document tools.
- `assets/document.html`: a self-contained, editable HTML starting point for reports and reading documents.

Read only the resources needed for the requested output. Adapt the template to the document rather than filling every optional section. Keep factual claims and sources intact; styling does not justify inventing content.

## Produce the document

1. Establish the output format and workspace destination from the request. Use the current workspace and a descriptive filename when these are unambiguous.
2. For HTML/PDF, read the template and design reference, then author complete UTF-8 HTML with inline CSS. For Markdown, preserve editable Markdown and use semantic headings, lists, tables and fenced code.
3. Use `document.render` when available. Its content is HTML for HTML/PDF output and Markdown for Markdown output. Follow the existing workspace mutation policy. The document tool creates the file and returns an artifact only after successful generation.
4. Inspect the requested output: check document structure for HTML/Markdown; use `pdf.read` for PDF text and page content where available. GUI preview is a user-facing reader; do not claim a visual inspection merely because a file was created.
5. Return a short description and the actual artifact reference. Distinguish a generated PDF from an HTML source, a preview, or an unsuccessful export. Preserve tool errors and report missing rendering dependencies directly.

The same Session and Kernel own tool execution, permissions and artifacts. This skill does not run a separate agent loop, update itself, install software automatically, or keep a separate preference store.
