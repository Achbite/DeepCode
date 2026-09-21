# Processes

Use `process` to manage long-running commands during the current run.

- `start`: choose an activated `bash`, `powershell`, or `container` tool and pass its execution input. Select `workspace` on the outer `process` call; omit workspace fields inside `input`. The normal Kernel permission checks still apply. A returned `jobId` means the command started, not that it succeeded.
- `wait`: wait for a job when subsequent work depends on its result. `waitSeconds` returns the current status at a check point without stopping the job; omit it to wait until completion.
- `status`: inspect a job when additional detail is needed. Status changes are supplied automatically during the run.
- `cancel`: stop the specified job and retain its output.

Do independent work while a job runs, or wait. Avoid changing the inputs or output directories of a running build or test. Omit `timeout` for no runtime deadline; an explicit timeout still terminates the command. Stopping the run stops its managed jobs. Existing containers are not deleted.

Container jobs use `container` with `action: exec`; activate Containers and create or authorize the container first. Use a separate temporary test container when the existing development environment should remain undisturbed.
