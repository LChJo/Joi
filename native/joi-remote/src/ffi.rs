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
    network::{ControllerConnector, RemoteConnectionPath, address_from_ticket, network_error_code},
    protocol::{ClientMessage, HostMessage, TransportTicket},
};

#[cfg(target_os = "android")]
static ANDROID_CONTEXT: std::sync::OnceLock<jni::objects::GlobalRef> = std::sync::OnceLock::new();

static RUNTIME: LazyLock<Runtime> =
    LazyLock::new(|| Runtime::new().expect("create Joi remote runtime"));
static CONTROLLERS: LazyLock<Mutex<HashMap<u64, ControllerHandle>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT_HANDLE: AtomicU64 = AtomicU64::new(1);
static CONNECTOR: LazyLock<ControllerConnector> = LazyLock::new(ControllerConnector::default);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ControllerConfig {
    connection_id: String,
    ticket: TransportTicket,
}

enum ControllerCommand {
    Send(Value),
}

struct ControllerHandle {
    task: tokio::task::AbortHandle,
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
    let task = RUNTIME.spawn(async move {
        emit(&events_tx, json!({ "type": "diagnostic", "code": "nativeDiagnosticsV3" })).await;
        #[cfg(target_os = "android")]
        emit(&events_tx, json!({ "type": "diagnostic", "code": if ANDROID_CONTEXT.get().is_some() {
            "androidContextReady"
        } else { "androidContextMissing" } })).await;
        let progress = |stage| {
            let key = if matches!(stage, "endpointBind" | "endpointDial" | "endpointRetry" | "endpointRelayWait" | "streamOpen" | "transportHello") { "stage" } else { "code" };
            let _ = events_tx.try_send(json!({ "type": "diagnostic", (key): stage }).to_string());
        };
        let mut controller = match CONNECTOR.connect(address, &connection_id, progress).await {
            Ok(controller) => controller,
            Err(error) => {
                emit(&events_tx, json!({ "type": "error", "code": network_error_code(error.as_ref()) })).await;
                return;
            }
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
                        if result.is_err() {
                            emit(&events_tx, json!({ "type": "error", "code": "sendFailed" })).await;
                            break;
                        }
                    }
                    None => break,
                },
                response = controller.recv() => match response {
                    Ok(HostMessage::Response { payload, .. }) => {
                        emit(&events_tx, json!({ "type": "frame", "frame": payload })).await;
                    }
                    Ok(HostMessage::Event { kind, payload }) => {
                        emit(&events_tx, json!({ "type": "event", "kind": kind, "payload": payload })).await;
                    }
                    Ok(HostMessage::Ready) => {}
                    Err(_) => {
                        emit(&events_tx, json!({ "type": "error", "code": "receiveFailed" })).await;
                        break;
                    },
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
        task.abort();
        return 0;
    };
    controllers.insert(
        handle,
        ControllerHandle {
            task: task.abort_handle(),
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
        controller.task.abort();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closing_a_dial_aborts_the_native_task() {
        let address = iroh::EndpointAddr::new(iroh::SecretKey::generate().public())
            .with_ip_addr("127.0.0.1:9".parse().unwrap());
        let config = CString::new(json!({ "connectionId": "cancel-test", "ticket": crate::network::ticket_from_address(&address) }).to_string()).unwrap();
        let handle = unsafe { joi_remote_controller_start(config.as_ptr()) };
        assert_ne!(handle, 0);
        let task = CONTROLLERS
            .lock()
            .unwrap()
            .get(&handle)
            .unwrap()
            .task
            .clone();
        RUNTIME.block_on(async {
            tokio::time::timeout(std::time::Duration::from_secs(3), async {
                loop {
                    let event = joi_remote_controller_poll(handle);
                    if !event.is_null() {
                        let text = unsafe { CStr::from_ptr(event) }
                            .to_str()
                            .unwrap()
                            .to_owned();
                        unsafe { joi_remote_string_free(event) };
                        if text.contains("endpointDial") {
                            break;
                        }
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("task must enter dial before cancellation");
        });
        assert!(!task.is_finished());
        joi_remote_controller_close(handle);
        RUNTIME.block_on(async {
            tokio::time::timeout(std::time::Duration::from_secs(1), async {
                while !task.is_finished() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("close must cancel dial immediately");
        });
        assert!(joi_remote_controller_poll(handle).is_null());
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
