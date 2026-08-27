use std::{
    collections::HashMap,
    ffi::{CStr, CString, c_char},
    sync::{
        LazyLock, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{runtime::Runtime, sync::mpsc};
use uuid::Uuid;

use crate::{
    network::{RemoteConnectionPath, address_from_ticket, connect},
    protocol::{ClientMessage, HostMessage, TransportTicket},
};

#[cfg(target_os = "android")]
static ANDROID_CONTEXT: std::sync::OnceLock<jni::objects::GlobalRef> = std::sync::OnceLock::new();

static RUNTIME: LazyLock<Runtime> =
    LazyLock::new(|| Runtime::new().expect("create Joi remote runtime"));
static CONTROLLERS: LazyLock<Mutex<HashMap<u64, ControllerHandle>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT_HANDLE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ControllerConfig {
    connection_id: String,
    ticket: TransportTicket,
}

enum ControllerCommand {
    Send(Value),
    Close,
}

struct ControllerHandle {
    commands: mpsc::Sender<ControllerCommand>,
    events: Mutex<mpsc::Receiver<String>>,
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn joi_remote_controller_start(config_json: *const c_char) -> u64 {
    let Some(config_json) = c_string(config_json) else {
        return 0;
    };
    let Ok(config) = serde_json::from_str::<ControllerConfig>(&config_json) else {
        return 0;
    };
    if config.connection_id.is_empty() || config.connection_id.len() > 160 {
        return 0;
    }
    let Ok(address) = address_from_ticket(&config.ticket) else {
        return 0;
    };
    let (commands_tx, mut commands_rx) = mpsc::channel(32);
    let (events_tx, events_rx) = mpsc::channel(64);
    let connection_id = config.connection_id;
    RUNTIME.spawn(async move {
        let Ok(mut controller) = connect(address, &connection_id).await else {
            emit(&events_tx, json!({ "type": "error", "code": "connectFailed" })).await;
            return;
        };
        let path = match controller.path() {
            RemoteConnectionPath::Direct => "direct",
            RemoteConnectionPath::Relay => "relay",
            RemoteConnectionPath::Mixed => "mixed",
        };
        emit(&events_tx, json!({ "type": "connected", "path": path })).await;
        let mut last_path = controller.path();
        let mut path_tick = tokio::time::interval(std::time::Duration::from_secs(2));
        path_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                command = commands_rx.recv() => match command {
                    Some(ControllerCommand::Send(frame)) => {
                        let result = controller.send(ClientMessage::Request {
                            kind: "frame".to_owned(),
                            payload: frame,
                            request_id: Uuid::new_v4().to_string(),
                        }).await;
                        if result.is_err() { break; }
                    }
                    Some(ControllerCommand::Close) | None => break,
                },
                response = controller.recv() => match response {
                    Ok(HostMessage::Response { payload, .. }) => {
                        emit(&events_tx, json!({ "type": "frame", "frame": payload })).await;
                    }
                    Ok(HostMessage::Event { kind, payload }) => {
                        emit(&events_tx, json!({ "type": "event", "kind": kind, "payload": payload })).await;
                    }
                    Ok(HostMessage::Ready) => {}
                    Err(_) => break,
                },
                _ = path_tick.tick() => {
                    let current_path = controller.path();
                    if current_path != last_path {
                        last_path = current_path;
                        let path = match current_path {
                            RemoteConnectionPath::Direct => "direct",
                            RemoteConnectionPath::Relay => "relay",
                            RemoteConnectionPath::Mixed => "mixed",
                        };
                        emit(&events_tx, json!({ "type": "path", "path": path })).await;
                    }
                }
            }
        }
        controller.close().await;
        emit(&events_tx, json!({ "type": "disconnected" })).await;
    });
    let handle = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
    let Ok(mut controllers) = CONTROLLERS.lock() else {
        return 0;
    };
    controllers.insert(
        handle,
        ControllerHandle {
            commands: commands_tx,
            events: Mutex::new(events_rx),
        },
    );
    handle
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn joi_remote_controller_send(
    handle: u64,
    frame_json: *const c_char,
) -> bool {
    let Some(frame_json) = c_string(frame_json) else {
        return false;
    };
    let Ok(frame) = serde_json::from_str::<Value>(&frame_json) else {
        return false;
    };
    let Ok(controllers) = CONTROLLERS.lock() else {
        return false;
    };
    let Some(controller) = controllers.get(&handle) else {
        return false;
    };
    controller
        .commands
        .try_send(ControllerCommand::Send(frame))
        .is_ok()
}

#[unsafe(no_mangle)]
pub extern "C" fn joi_remote_controller_poll(handle: u64) -> *mut c_char {
    let Ok(controllers) = CONTROLLERS.lock() else {
        return std::ptr::null_mut();
    };
    let Some(controller) = controllers.get(&handle) else {
        return std::ptr::null_mut();
    };
    let Ok(mut events) = controller.events.lock() else {
        return std::ptr::null_mut();
    };
    let Ok(event) = events.try_recv() else {
        return std::ptr::null_mut();
    };
    CString::new(event)
        .map(CString::into_raw)
        .unwrap_or(std::ptr::null_mut())
}

#[unsafe(no_mangle)]
pub extern "C" fn joi_remote_controller_close(handle: u64) {
    let Ok(mut controllers) = CONTROLLERS.lock() else {
        return;
    };
    if let Some(controller) = controllers.remove(&handle) {
        let _ = controller.commands.try_send(ControllerCommand::Close);
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn joi_remote_string_free(value: *mut c_char) {
    if !value.is_null() {
        // SAFETY: Pointers returned by `joi_remote_controller_poll` originate from CString::into_raw.
        drop(unsafe { CString::from_raw(value) });
    }
}

fn c_string(value: *const c_char) -> Option<String> {
    if value.is_null() {
        return None;
    }
    // SAFETY: The FFI caller promises a valid, NUL-terminated string for the duration of this call.
    unsafe { CStr::from_ptr(value) }
        .to_str()
        .ok()
        .map(ToOwned::to_owned)
}

async fn emit(events: &mpsc::Sender<String>, value: Value) {
    if let Ok(event) = serde_json::to_string(&value) {
        let _ = events.send(event).await;
    }
}

#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_aimana_joi_remote_MainActivity_initializeNativeRemote(
    env: jni::JNIEnv<'_>,
    _activity: jni::objects::JObject<'_>,
    context: jni::objects::JObject<'_>,
) {
    if ANDROID_CONTEXT.get().is_some() {
        return;
    }
    let Ok(java_vm) = env.get_java_vm() else {
        return;
    };
    let Ok(context) = env.new_global_ref(context) else {
        return;
    };
    let java_vm = java_vm.get_java_vm_pointer().cast();
    let context_pointer = context.as_obj().as_raw().cast();
    // SAFETY: JavaVM is process-scoped and the application Context is retained as a GlobalRef.
    unsafe { iroh::dns::install_android_jni_context(java_vm, context_pointer) };
    let _ = ANDROID_CONTEXT.set(context);
}
