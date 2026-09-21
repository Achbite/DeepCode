# Containers

Select this plugin when a task needs Docker. It adds one `container` tool; the core file tools and Agent Loop stay unchanged.

- `exec`: run a Shell command in a named Linux container. The Kernel resolves the full container ID and Docker context before approval. Select this task or this conversation to reuse access for later commands. A new container with the same name requires a new approval.
- `create`: create an independent test container from an image. `/project` is the selected workspace mounted read-only; `/work` is a separate test directory in the session workspace. Copy sources to `/work` when the build writes into its source tree. The container root filesystem and `/work` are writable. `network` is a Docker network name (`bridge` by default, or `none`); select the project's network when tests need other services. Creation approval includes use and cleanup of this temporary container during the task.
- `inspect`: show the prepared container configuration without executing a command inside it.

Use `command`, `cwd`, `timeout` as with Bash. Linux images need `/bin/sh` and `setsid` so cancellation can stop this call's process group. Output streams and full logs use the normal Kernel execution archive. The Kernel removes only containers it created; test files in the session workspace remain available for inspection and file-tool cleanup.

Existing containers retain their existing users, writable mounts, capabilities and network. Approval authorizes that environment; it does not make an existing writable project mount read-only. Prefer an independent test container when you need the project's working files protected. Docker socket access and arbitrary Docker commands in Host Shell remain full Host access, not container-scoped permission.

Keep reusable container names and image/network configuration in the project's existing Docker/Compose files. Resource configuration persists with the project; access grants expire independently. This plugin does not rewrite those files or stop the user's development containers.
