//! Own the descendants of this invocation, including on timeout/cancellation.
//! A Job Object controls process lifetimes, not filesystem permissions.
use deepcode_kernel_abi::{KernelError, KernelResult};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE},
    System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE},
    },
};

pub(crate) struct ProcessJob(HANDLE);

impl ProcessJob {
    pub fn attach(pid: u32) -> KernelResult<Self> {
        unsafe {
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() {
                return Err(last_error("open invocation process"));
            }
            let result = Self::attach_handle(process);
            CloseHandle(process);
            result
        }
    }

    pub fn attach_handle(process: HANDLE) -> KernelResult<Self> {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(last_error("create process job"));
            }
            let guard = Self(job);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
            {
                return Err(last_error("configure process job"));
            }
            let result = AssignProcessToJobObject(job, process);
            let error = (result == 0).then(|| last_error("attach invocation process to job"));
            if let Some(error) = error {
                return Err(error);
            }
            Ok(guard)
        }
    }
}

fn last_error(operation: &str) -> KernelError {
    KernelError::Other(format!("{operation}: {}", std::io::Error::last_os_error()))
}

impl Drop for ProcessJob {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
