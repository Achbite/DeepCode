# Echo MCP example

Add a connection in Settings → Plugins → Connect external tools, with your Python 3 executable as the command and the absolute path to `server.py` as its argument. The connection uses `stdio`. Set Capabilities to “Echo supplied text unchanged” so the Agent can discover it by task. This description is stored in the connection's `description` field. The server uses Python's standard library.

The Agent can use `plugin.search` with short capability keywords, then `plugin.activate` with the returned URI. Users can also select it with `@`. Registration and discovery do not start the server or expose its tool to every task. Activation prepares the tool for the next model request in the same run; calls already requested retain their original binding. A later run selects the capabilities it needs again. `echo` returns the supplied text unchanged through the normal Kernel execution and permission path.

The server exits when its input stream closes. The Host's MCP adapter owns its process and releases it when the prepared run is released.
