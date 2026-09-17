# Echo MCP example

Add a functional plugin in Settings with transport `stdio`, your Python 3 executable as the command, and the absolute path to `server.py` as its argument. The server uses Python's standard library.

Select the plugin in a conversation with `@`. Registration does not expose its tool to every task. Selecting it while a task is running prepares the tool for the next model request in the same run; calls already requested retain their original binding. `echo` returns the supplied text unchanged through the normal Kernel execution and permission path.

The server exits when its input stream closes. The Host's MCP adapter owns its process and releases it when the prepared run is released.
