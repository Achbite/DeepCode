# Display plugins and UI updates

DeepCode UI plugins customize presentation. Their lifecycle borrows two ideas from DeepSeek Harness: named slots with real consumers, and an owning scope that releases registrations, styles and effects when a plugin is replaced. DeepCode does not embed Cordis or its dynamic Host execution system. The Session loop, Provider, tool catalog, permissions and journal retain their existing owners.

## Use a plugin

In **Settings → Plugins → Add**, choose a local folder or manifest file containing `deepcode-ui.json`. The sample [`ui-plugins/reading-style`](../../ui-plugins/reading-style) can be used directly. Add the folder through the normal file picker, or enter its absolute path. Only add JavaScript you intend to run in the application window.

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

One selected plugin may own each slot, including the theme. Conflicting selections report an error; there is no implicit priority chain. Only the named presentation regions are replaceable; the app root, composer, permission controls and core services are not plugin slots.

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

The current TypeScript declaration is [types.ts](../../userspace/gui/src/ui-plugins/types.ts). UI generations are local loading identities, never substitutes for tool generations or version-equality gates. Reloading the plugin replaces its own DOM and effects; conversation state, drafts and scroll containers remain owned by the shell. Plugin-owned internal view state can reset on replacement.

## Whole UI and package builds

```sh
make ui
make ui-update UI_PACKAGE=/absolute/path/to/package
```

`make ui` compiles shared TypeScript and one GUI in Docker, writing `bin/ui/web-deepcode-gui`. `ui-update` stages the complete GUI directory and replaces the package's single Web directory. Native executables, Session resources and user configuration are retained. Close and reopen the window after updating the whole UI. Plugin hot replacement keeps the window and draft intact.

The native shells read Web resources through their filesystem protocols. Their Tauri configuration therefore has an empty embedded asset list; UI files are not copied into a second `shells/*/dist` tree or duplicated inside the executable. A normal platform package still invokes Cargo on current source and uses Cargo's dependency cache. No timestamp marker is used to skip source changes.

macOS packages place Web files in `Contents/Resources`. The local updater refreshes the outer app signature after replacing these resources, using the platform signing tools. Run it on macOS; Windows and Linux use the flat package Web directories.

New Host endpoints require a package containing this implementation once. Later display plugin edits and compatible whole-UI edits use these fast paths. Kernel, Session or native feature changes still use normal platform packaging.

## Component preview and source template

Each display plugin’s details in Settings → Plugins includes a component preview using the actual message and HTML Reader components. The content is labeled as examples. It shows the currently loaded plugin generations and uses the same mount/update/dispose path as a conversation.

Copy `ui-plugins/template` to a new plugin directory, edit its manifest and `src/index.ts`, then build inside Docker:

```sh
make ui-plugin UI_PLUGIN=ui-plugins/template
make ui-plugin-watch UI_PLUGIN=ui-plugins/template
make ui
make ui-update UI_PACKAGE=/absolute/path/to/package
```

Plugin builds produce `dist/index.js`; source watching rebuilds that module, while the existing Host watcher loads the finished module. Reader selection, scroll position, PDF page and zoom are owned by the shell and retained in the window session storage. Closing the window ends this view state. Native bridge changes still require packaging and restarting the Host.

## Tool contributions and CLI preference

The same management list includes tool and guidance sources. Existing owners remain separate: `plugins.sources` owns local CLI bundles, `plugins.disabled` records disabled built-in tools, `mcp.servers` owns external protocol servers, `skills.mounts` owns task guidance, and `workbench.uiPlugins` owns display modules. Inventory reads these sources and the display runtime; it is not another activation database.

Tools prefer CLI. A mature MCP adapter remains suitable when CLI would be substantially more complex. Built-in GitHub, PDF and arXiv tools now invoke `deepcode-first-party-provider --plugin <name> --call` directly: one JSON input and one result, no MCP initialization or persistent server. The legacy optional server entry remains available for explicit external use.

[CLI template](../../examples/plugins/cli-text/README.md) demonstrates a local `deepcode-tool.json` and a single-file entry. The Host reads metadata before adding; it does not run the entry during inspection. Registration and enabling do not expose tools until the user selects them. The Session checks selected implementations at the next request boundary, refreshing definitions, prompt contributions, aliases and bindings together. Disabled sources withdraw from that next request; prior requests and approvals retain their captured implementation. Kernel still authorizes and records execution. Changing the interpreter, native binary or Host requires the corresponding process/package update; the local source watcher does not reload Host services.

## Preview surfaces

One conversation-header button, after the run status, toggles the reader. Tabs retain loaded documents and native page instances while collapsed. The separator adjusts width; the upper-right expand/restore control fills the workspace and returns to split mode. Closing a tab closes that page; collapsing only hides it. Task and Session output cards keep their existing appearance. Artifact references use readable names while the reader exposes full locations on demand. Fixed artifacts read archived bytes, including historical screenshots.
