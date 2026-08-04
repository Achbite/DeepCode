use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::task::{AbortHandle, JoinHandle, JoinSet};

type OwnedWakeFutureV2 = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct HostKernelWakeKeyV2 {
    pub(crate) session_id: String,
    pub(crate) host_run_id: String,
    pub(crate) run_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HostKernelWakeOwnerV2 {
    pub(crate) key: HostKernelWakeKeyV2,
    pub(crate) identity_digest: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HostKernelWakeRegisterOutcomeV2 {
    Registered,
    AlreadyExact,
    OwnerConflict,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HostKernelWakeHandoffOutcomeV2 {
    Registered,
    Replaced,
    SupersededByRunCancellation,
    PreviousOwnerPanicked,
    OwnerConflict,
    ReplacementKeyMismatch,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HostKernelWakeRetagOutcomeV2 {
    Retagged,
    Missing,
    OwnerConflict,
    ReplacementKeyMismatch,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HostKernelWakeCancelOutcomeV2 {
    Cancelled,
    Missing,
    OwnerConflict,
}

#[derive(Clone, Debug)]
pub(crate) struct HostKernelWakeSupervisorErrorV2 {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl HostKernelWakeSupervisorErrorV2 {
    fn unavailable(message: impl Into<String>) -> Self {
        Self {
            code: "host_kernel_wake_supervisor_unavailable",
            message: message.into(),
        }
    }
}

#[derive(Clone)]
pub(crate) struct HostKernelWakeSupervisorV2 {
    sender: mpsc::UnboundedSender<HostKernelWakeCommandV2>,
    worker: Arc<Mutex<Option<JoinHandle<()>>>>,
}

impl HostKernelWakeSupervisorV2 {
    pub(crate) fn new() -> Self {
        let (sender, receiver) = mpsc::unbounded_channel();
        let worker = tokio::spawn(run_host_kernel_wake_supervisor_v2(receiver));
        Self {
            sender,
            worker: Arc::new(Mutex::new(Some(worker))),
        }
    }

    pub(crate) async fn register_exclusive<F>(
        &self,
        owner: HostKernelWakeOwnerV2,
        future: F,
    ) -> Result<HostKernelWakeRegisterOutcomeV2, HostKernelWakeSupervisorErrorV2>
    where
        F: Future<Output = ()> + Send + 'static,
    {
        let (reply, response) = oneshot::channel();
        self.sender
            .send(HostKernelWakeCommandV2::RegisterExclusive {
                owner,
                future: Box::pin(future),
                reply,
            })
            .map_err(|_| {
                HostKernelWakeSupervisorErrorV2::unavailable(
                    "Host Kernel wake supervisor is not accepting registrations",
                )
            })?;
        response.await.map_err(|_| {
            HostKernelWakeSupervisorErrorV2::unavailable(
                "Host Kernel wake supervisor ended before registration completed",
            )
        })
    }

    pub(crate) async fn replace_exact_or_register_missing<F>(
        &self,
        expected_owner: HostKernelWakeOwnerV2,
        replacement_owner: HostKernelWakeOwnerV2,
        future: F,
    ) -> Result<HostKernelWakeHandoffOutcomeV2, HostKernelWakeSupervisorErrorV2>
    where
        F: Future<Output = ()> + Send + 'static,
    {
        let (reply, response) = oneshot::channel();
        self.sender
            .send(HostKernelWakeCommandV2::ReplaceExactOrRegisterMissing {
                expected_owner,
                replacement_owner,
                future: Box::pin(future),
                reply,
            })
            .map_err(|_| {
                HostKernelWakeSupervisorErrorV2::unavailable(
                    "Host Kernel wake supervisor is not accepting exact handoffs",
                )
            })?;
        response.await.map_err(|_| {
            HostKernelWakeSupervisorErrorV2::unavailable(
                "Host Kernel wake supervisor ended before exact handoff completed",
            )
        })
    }

    pub(crate) async fn retag_exact(
        &self,
        expected_owner: HostKernelWakeOwnerV2,
        replacement_owner: HostKernelWakeOwnerV2,
    ) -> Result<HostKernelWakeRetagOutcomeV2, HostKernelWakeSupervisorErrorV2> {
        let (reply, response) = oneshot::channel();
        self.sender
            .send(HostKernelWakeCommandV2::RetagExact {
                expected_owner,
                replacement_owner,
                reply,
            })
            .map_err(|_| {
                HostKernelWakeSupervisorErrorV2::unavailable(
                    "Host Kernel wake supervisor is not accepting exact ownership retags",
                )
            })?;
        response.await.map_err(|_| {
            HostKernelWakeSupervisorErrorV2::unavailable(
                "Host Kernel wake supervisor ended before exact ownership retag completed",
            )
        })
    }

    pub(crate) async fn cancel_exact(
        &self,
        key: HostKernelWakeKeyV2,
    ) -> Result<bool, HostKernelWakeSupervisorErrorV2> {
        let (reply, response) = oneshot::channel();
        self.sender
            .send(HostKernelWakeCommandV2::Cancel { key, reply })
            .map_err(|_| {
                HostKernelWakeSupervisorErrorV2::unavailable(
                    "Host Kernel wake supervisor is not accepting cancellation",
                )
            })?;
        response.await.map_err(|_| {
            HostKernelWakeSupervisorErrorV2::unavailable(
                "Host Kernel wake supervisor ended before cancellation completed",
            )
        })
    }

    pub(crate) async fn cancel_owner_exact(
        &self,
        owner: HostKernelWakeOwnerV2,
    ) -> Result<HostKernelWakeCancelOutcomeV2, HostKernelWakeSupervisorErrorV2> {
        let (reply, response) = oneshot::channel();
        self.sender
            .send(HostKernelWakeCommandV2::CancelOwnerExact { owner, reply })
            .map_err(|_| {
                HostKernelWakeSupervisorErrorV2::unavailable(
                    "Host Kernel wake supervisor is not accepting exact-owner cancellation",
                )
            })?;
        response.await.map_err(|_| {
            HostKernelWakeSupervisorErrorV2::unavailable(
                "Host Kernel wake supervisor ended before exact-owner cancellation completed",
            )
        })
    }

    pub(crate) async fn owns_exact(
        &self,
        owner: HostKernelWakeOwnerV2,
    ) -> Result<bool, HostKernelWakeSupervisorErrorV2> {
        let (reply, response) = oneshot::channel();
        self.sender
            .send(HostKernelWakeCommandV2::OwnsExact { owner, reply })
            .map_err(|_| {
                HostKernelWakeSupervisorErrorV2::unavailable(
                    "Host Kernel wake supervisor is not accepting ownership queries",
                )
            })?;
        response.await.map_err(|_| {
            HostKernelWakeSupervisorErrorV2::unavailable(
                "Host Kernel wake supervisor ended before ownership query completed",
            )
        })
    }

    pub(crate) async fn shutdown(&self) -> Result<(), HostKernelWakeSupervisorErrorV2> {
        let mut worker = self.worker.lock().await;
        if worker.is_none() {
            return Ok(());
        }
        let (reply, response) = oneshot::channel();
        let acknowledgement = if self
            .sender
            .send(HostKernelWakeCommandV2::Shutdown { reply })
            .is_ok()
        {
            Some(response.await.map_err(|_| {
                HostKernelWakeSupervisorErrorV2::unavailable(
                    "Host Kernel wake supervisor ended before shutdown acknowledgement",
                )
            }))
        } else {
            None
        };
        let join_result = worker
            .as_mut()
            .expect("checked Host Kernel wake worker must remain present")
            .await;
        worker.take();
        join_result.map_err(|error| {
            HostKernelWakeSupervisorErrorV2::unavailable(format!(
                "Host Kernel wake supervisor join failed: {error}"
            ))
        })?;
        if let Some(acknowledgement) = acknowledgement {
            acknowledgement?;
        }
        Ok(())
    }
}

enum HostKernelWakeCommandV2 {
    RegisterExclusive {
        owner: HostKernelWakeOwnerV2,
        future: OwnedWakeFutureV2,
        reply: oneshot::Sender<HostKernelWakeRegisterOutcomeV2>,
    },
    ReplaceExactOrRegisterMissing {
        expected_owner: HostKernelWakeOwnerV2,
        replacement_owner: HostKernelWakeOwnerV2,
        future: OwnedWakeFutureV2,
        reply: oneshot::Sender<HostKernelWakeHandoffOutcomeV2>,
    },
    RetagExact {
        expected_owner: HostKernelWakeOwnerV2,
        replacement_owner: HostKernelWakeOwnerV2,
        reply: oneshot::Sender<HostKernelWakeRetagOutcomeV2>,
    },
    Cancel {
        key: HostKernelWakeKeyV2,
        reply: oneshot::Sender<bool>,
    },
    CancelOwnerExact {
        owner: HostKernelWakeOwnerV2,
        reply: oneshot::Sender<HostKernelWakeCancelOutcomeV2>,
    },
    OwnsExact {
        owner: HostKernelWakeOwnerV2,
        reply: oneshot::Sender<bool>,
    },
    Shutdown {
        reply: oneshot::Sender<()>,
    },
}

struct HostKernelWakeEntryV2 {
    identity_digest: String,
    generation: u64,
    task_id: tokio::task::Id,
    abort_handle: AbortHandle,
}

struct HostKernelWakeCompletionV2 {
    key: HostKernelWakeKeyV2,
    generation: u64,
}

struct HostKernelWakeQuiescingV2 {
    generation: u64,
    task_id: tokio::task::Id,
    after_quiescence: HostKernelWakeAfterQuiescenceV2,
}

enum HostKernelWakeAfterQuiescenceV2 {
    Replace {
        replacement_owner: HostKernelWakeOwnerV2,
        future: OwnedWakeFutureV2,
        reply: oneshot::Sender<HostKernelWakeHandoffOutcomeV2>,
    },
    Cancel {
        reply: oneshot::Sender<bool>,
        superseded_handoff_reply: Option<oneshot::Sender<HostKernelWakeHandoffOutcomeV2>>,
    },
    CancelOwner {
        reply: oneshot::Sender<HostKernelWakeCancelOutcomeV2>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HostKernelWakeTaskExitV2 {
    Completed,
    Cancelled,
    Panicked,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HostKernelWakeExactStateV2 {
    Missing,
    Finished,
    Exact,
    OwnerConflict,
}

fn host_kernel_wake_exact_state_v2(
    entries: &HashMap<HostKernelWakeKeyV2, HostKernelWakeEntryV2>,
    owner: &HostKernelWakeOwnerV2,
) -> HostKernelWakeExactStateV2 {
    match entries.get(&owner.key) {
        None => HostKernelWakeExactStateV2::Missing,
        Some(entry) if entry.abort_handle.is_finished() => HostKernelWakeExactStateV2::Finished,
        Some(entry) if entry.identity_digest == owner.identity_digest => {
            HostKernelWakeExactStateV2::Exact
        }
        Some(_) => HostKernelWakeExactStateV2::OwnerConflict,
    }
}

fn spawn_host_kernel_wake_v2(
    tasks: &mut JoinSet<HostKernelWakeCompletionV2>,
    entries: &mut HashMap<HostKernelWakeKeyV2, HostKernelWakeEntryV2>,
    next_generation: &mut u64,
    owner: HostKernelWakeOwnerV2,
    future: OwnedWakeFutureV2,
) {
    let generation = *next_generation;
    *next_generation = next_generation.wrapping_add(1).max(1);
    let key = owner.key.clone();
    let abort_handle = tasks.spawn(async move {
        future.await;
        HostKernelWakeCompletionV2 { key, generation }
    });
    let task_id = abort_handle.id();
    entries.insert(
        owner.key,
        HostKernelWakeEntryV2 {
            identity_digest: owner.identity_digest,
            generation,
            task_id,
            abort_handle,
        },
    );
}

fn finish_host_kernel_wake_quiescence_v2(
    key: HostKernelWakeKeyV2,
    quiescing: HostKernelWakeQuiescingV2,
    task_exit: HostKernelWakeTaskExitV2,
    tasks: &mut JoinSet<HostKernelWakeCompletionV2>,
    entries: &mut HashMap<HostKernelWakeKeyV2, HostKernelWakeEntryV2>,
    next_generation: &mut u64,
) {
    match quiescing.after_quiescence {
        HostKernelWakeAfterQuiescenceV2::Replace {
            replacement_owner,
            future,
            reply,
        } => {
            debug_assert_eq!(key, replacement_owner.key);
            if task_exit == HostKernelWakeTaskExitV2::Panicked {
                let _ = reply.send(HostKernelWakeHandoffOutcomeV2::PreviousOwnerPanicked);
            } else {
                spawn_host_kernel_wake_v2(
                    tasks,
                    entries,
                    next_generation,
                    replacement_owner,
                    future,
                );
                let _ = reply.send(HostKernelWakeHandoffOutcomeV2::Replaced);
            }
        }
        HostKernelWakeAfterQuiescenceV2::Cancel {
            reply,
            superseded_handoff_reply,
        } => {
            if let Some(handoff_reply) = superseded_handoff_reply {
                let _ =
                    handoff_reply.send(HostKernelWakeHandoffOutcomeV2::SupersededByRunCancellation);
            }
            let _ = reply.send(true);
        }
        HostKernelWakeAfterQuiescenceV2::CancelOwner { reply } => {
            let _ = reply.send(HostKernelWakeCancelOutcomeV2::Cancelled);
        }
    }
}

async fn run_host_kernel_wake_supervisor_v2(
    mut receiver: mpsc::UnboundedReceiver<HostKernelWakeCommandV2>,
) {
    let mut tasks = JoinSet::<HostKernelWakeCompletionV2>::new();
    let mut entries = HashMap::<HostKernelWakeKeyV2, HostKernelWakeEntryV2>::new();
    let mut quiescing = HashMap::<HostKernelWakeKeyV2, HostKernelWakeQuiescingV2>::new();
    let mut next_generation = 1_u64;
    loop {
        tokio::select! {
            command = receiver.recv() => {
                let Some(command) = command else {
                    entries.clear();
                    quiescing.clear();
                    tasks.abort_all();
                    while tasks.join_next().await.is_some() {}
                    return;
                };
                match command {
                    HostKernelWakeCommandV2::RegisterExclusive { owner, future, reply } => {
                        if quiescing.contains_key(&owner.key) {
                            let _ = reply.send(
                                HostKernelWakeRegisterOutcomeV2::OwnerConflict,
                            );
                            continue;
                        }
                        match host_kernel_wake_exact_state_v2(&entries, &owner) {
                            HostKernelWakeExactStateV2::Exact => {
                                let _ = reply.send(
                                    HostKernelWakeRegisterOutcomeV2::AlreadyExact,
                                );
                                continue;
                            }
                            HostKernelWakeExactStateV2::OwnerConflict => {
                                let _ = reply.send(
                                    HostKernelWakeRegisterOutcomeV2::OwnerConflict,
                                );
                                continue;
                            }
                            HostKernelWakeExactStateV2::Finished => {
                                entries.remove(&owner.key);
                            }
                            HostKernelWakeExactStateV2::Missing => {}
                        }
                        spawn_host_kernel_wake_v2(
                            &mut tasks,
                            &mut entries,
                            &mut next_generation,
                            owner,
                            future,
                        );
                        let _ = reply.send(HostKernelWakeRegisterOutcomeV2::Registered);
                    }
                    HostKernelWakeCommandV2::ReplaceExactOrRegisterMissing {
                        expected_owner,
                        replacement_owner,
                        future,
                        reply,
                    } => {
                        if expected_owner.key != replacement_owner.key {
                            let _ = reply.send(
                                HostKernelWakeHandoffOutcomeV2::ReplacementKeyMismatch,
                            );
                            continue;
                        }
                        if quiescing.contains_key(&expected_owner.key) {
                            let _ = reply.send(
                                HostKernelWakeHandoffOutcomeV2::OwnerConflict,
                            );
                            continue;
                        }
                        match host_kernel_wake_exact_state_v2(
                            &entries,
                            &expected_owner,
                        ) {
                            HostKernelWakeExactStateV2::Exact => {
                                let entry = entries
                                    .remove(&expected_owner.key)
                                    .expect("checked exact wake owner must remain present");
                                let HostKernelWakeEntryV2 {
                                    generation,
                                    task_id,
                                    abort_handle,
                                    ..
                                } = entry;
                                abort_handle.abort();
                                let previous = quiescing.insert(
                                    expected_owner.key,
                                    HostKernelWakeQuiescingV2 {
                                        generation,
                                        task_id,
                                        after_quiescence:
                                            HostKernelWakeAfterQuiescenceV2::Replace {
                                                replacement_owner,
                                                future,
                                                reply,
                                            },
                                    },
                                );
                                debug_assert!(previous.is_none());
                            }
                            HostKernelWakeExactStateV2::Missing => {
                                spawn_host_kernel_wake_v2(
                                    &mut tasks,
                                    &mut entries,
                                    &mut next_generation,
                                    replacement_owner,
                                    future,
                                );
                                let _ = reply.send(
                                    HostKernelWakeHandoffOutcomeV2::Registered,
                                );
                            }
                            HostKernelWakeExactStateV2::Finished => {
                                entries.remove(&expected_owner.key);
                                spawn_host_kernel_wake_v2(
                                    &mut tasks,
                                    &mut entries,
                                    &mut next_generation,
                                    replacement_owner,
                                    future,
                                );
                                let _ = reply.send(
                                    HostKernelWakeHandoffOutcomeV2::Registered,
                                );
                            }
                            HostKernelWakeExactStateV2::OwnerConflict => {
                                let _ = reply.send(
                                    HostKernelWakeHandoffOutcomeV2::OwnerConflict,
                                );
                            }
                        }
                    }
                    HostKernelWakeCommandV2::RetagExact {
                        expected_owner,
                        replacement_owner,
                        reply,
                    } => {
                        if expected_owner.key != replacement_owner.key {
                            let _ = reply.send(
                                HostKernelWakeRetagOutcomeV2::ReplacementKeyMismatch,
                            );
                            continue;
                        }
                        if quiescing.contains_key(&expected_owner.key) {
                            let _ = reply.send(
                                HostKernelWakeRetagOutcomeV2::OwnerConflict,
                            );
                            continue;
                        }
                        let outcome = match host_kernel_wake_exact_state_v2(
                            &entries,
                            &expected_owner,
                        ) {
                            HostKernelWakeExactStateV2::Finished => {
                                entries.remove(&expected_owner.key);
                                HostKernelWakeRetagOutcomeV2::Missing
                            }
                            HostKernelWakeExactStateV2::OwnerConflict => {
                                HostKernelWakeRetagOutcomeV2::OwnerConflict
                            }
                            HostKernelWakeExactStateV2::Exact => {
                                let entry = entries
                                    .get_mut(&expected_owner.key)
                                    .expect("checked exact wake owner must remain present");
                                entry.identity_digest = replacement_owner.identity_digest;
                                HostKernelWakeRetagOutcomeV2::Retagged
                            }
                            HostKernelWakeExactStateV2::Missing => {
                                HostKernelWakeRetagOutcomeV2::Missing
                            }
                        };
                        let _ = reply.send(outcome);
                    }
                    HostKernelWakeCommandV2::Cancel { key, reply } => {
                        if let Some(mut reservation) = quiescing.remove(&key) {
                            match reservation.after_quiescence {
                                HostKernelWakeAfterQuiescenceV2::Replace {
                                    reply: handoff_reply,
                                    ..
                                } => {
                                    reservation.after_quiescence =
                                        HostKernelWakeAfterQuiescenceV2::Cancel {
                                            reply,
                                            superseded_handoff_reply: Some(handoff_reply),
                                        };
                                    let previous = quiescing.insert(key, reservation);
                                    debug_assert!(previous.is_none());
                                }
                                after_quiescence => {
                                    reservation.after_quiescence = after_quiescence;
                                    let previous = quiescing.insert(key, reservation);
                                    debug_assert!(previous.is_none());
                                    let _ = reply.send(false);
                                }
                            }
                            continue;
                        }
                        let Some(entry) = entries.remove(&key) else {
                            let _ = reply.send(false);
                            continue;
                        };
                        if entry.abort_handle.is_finished() {
                            let _ = reply.send(true);
                            continue;
                        }
                        let HostKernelWakeEntryV2 {
                            generation,
                            task_id,
                            abort_handle,
                            ..
                        } = entry;
                        abort_handle.abort();
                        let previous = quiescing.insert(
                            key,
                            HostKernelWakeQuiescingV2 {
                                generation,
                                task_id,
                                after_quiescence: HostKernelWakeAfterQuiescenceV2::Cancel {
                                    reply,
                                    superseded_handoff_reply: None,
                                },
                            },
                        );
                        debug_assert!(previous.is_none());
                    }
                    HostKernelWakeCommandV2::CancelOwnerExact { owner, reply } => {
                        if quiescing.contains_key(&owner.key) {
                            let _ = reply.send(
                                HostKernelWakeCancelOutcomeV2::OwnerConflict,
                            );
                            continue;
                        }
                        let outcome = match host_kernel_wake_exact_state_v2(&entries, &owner) {
                            HostKernelWakeExactStateV2::Exact => {
                                let entry = entries
                                    .remove(&owner.key)
                                    .expect("checked exact wake owner must remain present");
                                let HostKernelWakeEntryV2 {
                                    generation,
                                    task_id,
                                    abort_handle,
                                    ..
                                } = entry;
                                abort_handle.abort();
                                let previous = quiescing.insert(
                                    owner.key,
                                    HostKernelWakeQuiescingV2 {
                                        generation,
                                        task_id,
                                        after_quiescence:
                                            HostKernelWakeAfterQuiescenceV2::CancelOwner {
                                                reply,
                                            },
                                    },
                                );
                                debug_assert!(previous.is_none());
                                continue;
                            }
                            HostKernelWakeExactStateV2::Missing => {
                                HostKernelWakeCancelOutcomeV2::Missing
                            }
                            HostKernelWakeExactStateV2::Finished => {
                                entries.remove(&owner.key);
                                HostKernelWakeCancelOutcomeV2::Missing
                            }
                            HostKernelWakeExactStateV2::OwnerConflict => {
                                HostKernelWakeCancelOutcomeV2::OwnerConflict
                            }
                        };
                        let _ = reply.send(outcome);
                    }
                    HostKernelWakeCommandV2::OwnsExact { owner, reply } => {
                        let owned = !quiescing.contains_key(&owner.key)
                            && entries.get(&owner.key).is_some_and(|entry| {
                                entry.identity_digest == owner.identity_digest
                                    && !entry.abort_handle.is_finished()
                            });
                        let _ = reply.send(owned);
                    }
                    HostKernelWakeCommandV2::Shutdown { reply } => {
                        receiver.close();
                        entries.clear();
                        quiescing.clear();
                        tasks.abort_all();
                        while tasks.join_next().await.is_some() {}
                        let _ = reply.send(());
                        return;
                    }
                }
            }
            completion = tasks.join_next(), if !tasks.is_empty() => {
                match completion {
                    Some(Ok(completion)) => {
                        if quiescing.get(&completion.key).is_some_and(|entry| {
                            entry.generation == completion.generation
                        }) {
                            let transition = quiescing
                                .remove(&completion.key)
                                .expect("matched quiescing wake must remain present");
                            finish_host_kernel_wake_quiescence_v2(
                                completion.key,
                                transition,
                                HostKernelWakeTaskExitV2::Completed,
                                &mut tasks,
                                &mut entries,
                                &mut next_generation,
                            );
                        } else if entries.get(&completion.key).is_some_and(|entry| {
                            entry.generation == completion.generation
                        }) {
                            entries.remove(&completion.key);
                        }
                    }
                    Some(Err(error)) => {
                        let task_id = error.id();
                        let task_exit = if error.is_cancelled() {
                            HostKernelWakeTaskExitV2::Cancelled
                        } else if error.is_panic() {
                            HostKernelWakeTaskExitV2::Panicked
                        } else {
                            debug_assert!(
                                false,
                                "Tokio JoinError must be cancelled or panicked"
                            );
                            HostKernelWakeTaskExitV2::Panicked
                        };
                        let quiescing_key = quiescing.iter().find_map(|(key, entry)| {
                            (entry.task_id == task_id).then(|| key.clone())
                        });
                        if let Some(key) = quiescing_key {
                            let transition = quiescing
                                .remove(&key)
                                .expect("matched quiescing wake must remain present");
                            finish_host_kernel_wake_quiescence_v2(
                                key,
                                transition,
                                task_exit,
                                &mut tasks,
                                &mut entries,
                                &mut next_generation,
                            );
                        } else {
                            entries.retain(|_, entry| entry.task_id != task_id);
                        }
                    }
                    None => {}
                }
            }
        }
    }
}
