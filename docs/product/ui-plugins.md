# Display plugins and UI updates

DeepCode UI plugins customize messages, document readers, themes and supported settings panels. Replacing a plugin releases its registrations, styles and effects. Plugins receive the published display inputs; they do not control conversation execution or permissions.

## Use a plugin

In **Settings → Plugins → Add**, choose a local folder or manifest file containing `deepcode-ui.json`. Add the folder through the normal file picker, or enter its absolute path. Only add JavaScript you intend to run in the application window.

The Host checks the selected files while the window is connected and publishes changed contents. Saving the entry bundle or manifest replaces that plugin in the open window; no UI reload, Rust build, daemon restart or new conversation is required. **Refresh list** reconnects the source watch; **Reload** in one plugin’s details reloads only that module. Disabling or removing a plugin releases its resources and restores the built-in renderer for its slots.

The source list is stored in the existing user setting `workbench.uiPlugins` and used by the GUI. It is independent of Skill/MCP activation. A broken source or renderer shows its own error in the settings page and affected slot. A disconnected watch is visible and can be reconnected with Refresh; it does not silently reload the application.

## Manifest and module

```json
{
  "id": "example.reader",
  "name": "My Reader",
  "entry": "index.js",
  "slots": ["document.html", "theme"]
}
```

The entry is one standalone browser ES module, exporting `default { apply(context) }`. It can use DOM directly or bundle its own rendering library. Build imports, styles and dependencies into this entry; relative imports from the generated Blob URL are not a supported module graph. Do not start timers, fetches or listeners at module top level. Module top level defines code; `apply` and renderer mounts own effects.

Supported slots:

| Slot | Input and owner |
| --- | --- |
| `message.plain`, `message.markdown` | Committed message text, format, locale and theme. Session still owns the text and message status. |
| `document.html`, `document.markdown`, `document.pdf` | The actual document Blob, filename, format, locale and theme. Host retains the dialog and download operation. |
| `theme` | CSS registered through `context.addStyle`. It is removed when the module unloads. |
| `settings.models.overview` | Public connection and adapter catalog. Multiple contributions appear in configured order. |
| `settings.connection.detail` | The current redacted connection; optional `adapterId` scopes the contribution. |
| `settings.usage.panel` | Current query and usage report, including Session attribution. |
| `tool.result` | Original activity projection, selected by the manifest's required `toolId` (tool operation). Tool status and failures remain outside this renderer. |

One selected plugin may own each replacement slot, including the theme; `tool.result` ownership is per operation. Settings contributions compose in configured order. Conflicting replacements report an error; there is no implicit priority chain. Only the named presentation regions are replaceable; the app root, composer, permission controls and core services are not plugin slots.

Settings manifests can declare `capabilities: ["usage.read"]` to receive `scope.usage.query(query, signal)`. Usage panels render the supplied usage report and retain its query interval and Session attribution. `connection.auth` provides login, cancellation, logout and quota operations only in `settings.connection.detail`, bound to that connection. Tokens and keys never enter these inputs. A view can read or cancel only the auth flows it started; disposal cancels pending flows. Message/document renderers retain their display-only boundary.

```js
export default {
  apply(ctx) {
    ctx.register('message.plain', (container, input, scope) => {
      const paragraph = document.createElement('p');
      container.append(paragraph);
      const update = (next) => { paragraph.textContent = next.text; };
      update(input);
      return { update, dispose() { paragraph.remove(); } };
    });
  }
};
```

`apply` registers every declared non-theme slot before it returns or its Promise resolves. It may return one cleanup function, including an asynchronous function. Replacement aborts the old scope, waits for its child views and module cleanup, then applies the next module. Cleanup errors remain visible. Each renderer returns `update(input)` and `dispose()`; `dispose()` may return a Promise. `update` handles changed display inputs without restarting a module. Both module and mount scopes expose:

- `signal`: aborted when the scope ends; pass it to asynchronous work and event listeners.
- `onDispose(fn)`: release subscriptions, timers or custom resources.
- `addStyle(css)`: append an owned stylesheet that is removed automatically.
- `reportError(error)`: report asynchronous failures for this plugin; the error is displayed and its active presentation is released.

Reloading the plugin replaces its own DOM and effects; conversation state, drafts and scroll containers remain owned by the shell. Plugin-owned internal view state can reset on replacement.

## Application updates

Close and reopen DeepCode after installing an application update. Editing an enabled UI plugin updates that plugin in the current window and keeps the conversation draft intact. Native application or backend changes require a program update.

## Component preview and source template

Each display plugin’s details in Settings → Plugins includes a component preview using the actual message and HTML Reader components. The content is labeled as examples. It shows the currently loaded plugin generations and uses the same mount/update/dispose path as a conversation.

A plugin folder contains its manifest and declared standalone JavaScript module. TypeScript sources must be compiled to that module; the Host watches the finished module and manifest. Reader selection, scroll position, PDF page and zoom stay with the open window.

## Tool contributions and CLI preference

The same management list includes tool and guidance sources. Existing owners remain separate: `plugins.sources` owns local CLI bundles, `plugins.disabled` records disabled built-in tools, `mcp.servers` owns external protocol servers, `skills.mounts` owns task guidance, and `workbench.uiPlugins` owns display modules. Inventory reads these sources and the display runtime; it is not another activation database.

Local CLI bundles, MCP servers and text Skills can contribute capabilities. Registration, activation and execution permissions are separate: adding a source does not authorize its tools to access files or run commands.

A local CLI plugin uses a `deepcode-tool.json` manifest and its declared executable entry. The Host reads metadata before adding; it does not run the entry during inspection. See [plugin activation and update timing](operations.md#models-and-context) for user mentions, Agent activation and the distinction between source updates and saved configuration changes. Changing an interpreter, native binary or Host requires the corresponding process/package update.

## Preview surfaces

One conversation-header button, after the run status, toggles the reader. Tabs retain loaded documents and native page instances while collapsed. The separator adjusts width; the upper-right expand/restore control fills the workspace and returns to split mode. Closing a tab closes that page; collapsing only hides it. Task and Session output cards keep their existing appearance. Artifact references use readable names while the reader exposes full locations on demand. Fixed artifacts read archived bytes, including historical screenshots.

The native browser's **Annotate / 批注** button sits immediately to the right of Refresh. Select a DOM element or draw a region, enter a comment and add it to the ordinary conversation draft. Page URL, selector, viewport and selected text are quoted as page evidence, separately from the comment. macOS also attaches the marked viewport capture using the existing image attachment path; other platforms retain region metadata because native capture is currently macOS-only. Frames are selectable as a box; use region selection for details inside a frame. Escape cancels selection, and closing, navigating, resizing or switching away ends annotation. Nothing is automatically submitted to the model.

Dragging the reader separator suppresses text selection only for the drag lifetime. Pointer release, cancellation, loss of capture, window blur and unmount restore normal selection and copying.
