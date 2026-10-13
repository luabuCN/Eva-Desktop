use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::ShellExt;

struct SidecarChild(Mutex<Option<tauri_plugin_shell::process::CommandChild>>);

/// 关闭主窗口时的行为："tray" = 隐藏到托盘，"quit" = 退出应用。
/// 默认 tray；前端启动时和设置变更时通过 set_close_behavior 命令同步。
#[derive(Default)]
struct CloseBehavior(Mutex<String>);

#[tauri::command]
fn set_close_behavior(
    behavior: String,
    state: tauri::State<CloseBehavior>,
) -> Result<(), String> {
    if !matches!(behavior.as_str(), "tray" | "quit") {
        return Err(format!("unknown close behavior: {behavior}"));
    }
    *state.0.lock().map_err(|error| error.to_string())? = behavior;
    Ok(())
}

/// 保存图片到用户选择的位置：弹系统「另存为」对话框，默认定位系统下载
/// 目录并预填文件名，用户取消返回 false。Rust 侧直接写文件，不引入
/// fs 插件及其路径 scope（webview 里 attachment 下载只会触发 WebView2
/// 自带的保存弹窗，无法控制默认目录与完成反馈，故走自定义命令）。
#[tauri::command]
fn save_image_with_dialog(
    app: tauri::AppHandle,
    bytes: Vec<u8>,
    file_name: String,
) -> Result<bool, String> {
    let mut dialog = app
        .dialog()
        .file()
        .add_filter("图片", &["png", "jpg", "jpeg", "webp"])
        .set_file_name(&file_name);
    if let Ok(downloads) = app.path().download_dir() {
        dialog = dialog.set_directory(downloads);
    }
    let Some(target) = dialog.blocking_save_file() else {
        return Ok(false);
    };
    let path = target
        .into_path()
        .map_err(|_| "不支持的保存位置".to_string())?;
    std::fs::write(path, bytes).map_err(|error| error.to_string())?;
    Ok(true)
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn port_in_use(host: &str, port: u16) -> bool {
    let addr = format!("{host}:{port}")
        .parse::<std::net::SocketAddr>()
        .unwrap_or_else(|_| std::net::SocketAddr::from(([127, 0, 0, 1], port)));
    std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![set_close_behavior, save_image_with_dialog])
        .on_window_event(|window, event| {
            // 关闭行为为 tray 时拦截关闭，仅隐藏窗口；quit 时走默认关闭流程
            // （最后一个窗口关闭即退出应用，RunEvent::Exit 会带走 sidecar）。
            if let WindowEvent::CloseRequested { api, .. } = event {
                let use_tray = window
                    .app_handle()
                    .state::<CloseBehavior>()
                    .0
                    .lock()
                    .map(|behavior| behavior.as_str() != "quit")
                    .unwrap_or(true);
                if use_tray {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            app.manage(CloseBehavior(Mutex::new("tray".to_string())));

            let show_item = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let quit_item =
                MenuItem::with_id(app, "quit", "退出 Eva Desktop", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Eva Desktop")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;

            let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
            let port = std::env::var("OPENHARNESS_PORT")
                .ok()
                .and_then(|value| value.parse::<u16>().ok())
                .unwrap_or(8878);

            // `pnpm dev` runs the tsx API server on the same port and sets
            // OPENHARNESS_SKIP_SIDECAR so we never race it for the port.
            let skip_sidecar = std::env::var("OPENHARNESS_SKIP_SIDECAR")
                .map(|value| !matches!(value.as_str(), "" | "0" | "false"))
                .unwrap_or(false);
            if skip_sidecar {
                println!("[sidecar] OPENHARNESS_SKIP_SIDECAR set, skipping sidecar (external API server assumed)");
                app.manage(SidecarChild(Mutex::new(None)));
                return Ok(());
            }

            // Remaining overlaps: a packaged build started next to a dev
            // server, or a second app instance. Reuse whichever server got
            // there first.
            if port_in_use(&host, port) {
                println!(
                    "[sidecar] {host}:{port} already in use, skipping sidecar (external API server assumed)"
                );
                app.manage(SidecarChild(Mutex::new(None)));
                return Ok(());
            }

            let sidecar = app.shell().sidecar("open-harness-sidecar")?;
            let sidecar = sidecar
                .env("OPENHARNESS_DATA_DIR", &data_dir)
                .env("OPENHARNESS_PORT", port.to_string());

            let (mut rx, child) = sidecar.spawn()?;
            app.manage(SidecarChild(Mutex::new(Some(child))));

            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        tauri_plugin_shell::process::CommandEvent::Stdout(line) => {
                            println!("[sidecar] {}", String::from_utf8_lossy(&line));
                        }
                        tauri_plugin_shell::process::CommandEvent::Stderr(line) => {
                            eprintln!("[sidecar] {}", String::from_utf8_lossy(&line));
                        }
                        _ => {}
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Tauri application");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            if let Some(child) = app_handle
                .state::<SidecarChild>()
                .0
                .lock()
                .ok()
                .and_then(|mut child| child.take())
            {
                let _ = child.kill();
            }
        }
    });
}
