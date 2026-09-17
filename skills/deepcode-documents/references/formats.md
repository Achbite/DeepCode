# Output formats

## HTML

Use HTML for a styled, editable document with a browser preview. Start from `assets/document.html`, retain the user's language, replace sample content and adjust the structure. Embed CSS and required small images/SVG so the preview and delivered file agree.

Call `document.render` with `format: "html"`, a workspace-relative `.html` path and complete HTML in `content`.

## PDF

Use PDF when the user needs fixed pages for sharing or printing. Author the document as HTML first; PDF export uses WeasyPrint's paged HTML/CSS engine. Supply the same complete HTML to `document.render` with `format: "pdf"` and a `.pdf` destination.

PDF rendering requires the document renderer's WeasyPrint environment. A missing renderer is a tool failure; it is not a successful PDF export. Do not install dependencies or change the user's environment without authorization. HTML and Markdown output remain separate requested formats, not automatic substitutes for a failed PDF request.

The renderer does not run scripts. Use inline SVG or embedded image data for diagrams and formulas. System fonts are resolved by the rendering environment; use installed fonts that cover the document's language.

For text verification, `pdf.read` reads a bounded page range from the generated PDF. The GUI document reader displays PDF pages and lets the user navigate and zoom. Text extraction alone does not prove the visual layout.

## Markdown

Use Markdown when editability and repository-friendly source matter. Call `document.render` with `format: "markdown"`, a `.md` path and Markdown in `content`.

Use Markdown headings, meaningful link labels, fenced code with a language and tables only where useful. Avoid using raw HTML/CSS to imitate a page layout in Markdown. The GUI preview renders the Markdown; its typography follows the application theme.

## Delivery

`document.render` writes to the prepared workspace destination and returns the actual artifact metadata. Use that artifact in the answer. Supply both source and PDF only when requested or useful to the user's stated deliverable. Do not claim download, publication, printing or visual review without performing that action.
