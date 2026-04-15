use std::path::PathBuf;
use std::process::Command;
use tauri::menu::{MenuBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

fn set_app_icon(window: &tauri::WebviewWindow, theme: tauri::Theme) {
    let icon_bytes: &[u8] = match theme {
        tauri::Theme::Light => include_bytes!("../icons/icon-light.png"),
        _ => include_bytes!("../icons/icon-dark.png"),
    };
    if let Ok(img) = image::load_from_memory(icon_bytes) {
        let (w, h) = (img.width(), img.height());
        let rgba = img.into_rgba8().into_raw();
        let icon = tauri::image::Image::new_owned(rgba, w, h);
        let _ = window.set_icon(icon);
    }
}

/// Get the piper models directory
fn piper_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap().join("piper")
}

/// List available voice models
#[tauri::command]
async fn piper_list_voices(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = piper_dir(&app).join("models");
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut voices = vec![];
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(".onnx") {
            voices.push(name.trim_end_matches(".onnx").to_string());
        }
    }
    Ok(voices)
}

/// Synthesize speech from text using piper CLI
#[tauri::command]
async fn piper_speak(
    app: tauri::AppHandle,
    text: String,
    voice: String,
    speed: Option<f32>,
) -> Result<String, String> {
    let piper_path = piper_dir(&app);
    let bin = if cfg!(target_os = "windows") {
        piper_path.join("piper.exe")
    } else {
        piper_path.join("piper")
    };

    if !bin.exists() {
        return Err("Piper not installed. Download it from Settings > TTS.".to_string());
    }

    let model_path = piper_path.join("models").join(format!("{}.onnx", voice));
    if !model_path.exists() {
        return Err(format!("Voice model '{}' not found", voice));
    }

    // Output to a temp WAV file
    let output_path = piper_path.join("output.wav");

    let mut cmd = Command::new(&bin);
    cmd.arg("--model")
        .arg(&model_path)
        .arg("--output_file")
        .arg(&output_path);

    if let Some(spd) = speed {
        cmd.arg("--length_scale")
            .arg(format!("{:.2}", 1.0 / spd));
    }

    // Pipe text via stdin
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start piper: {}", e))?;

    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        stdin.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    }

    let output = child.wait_with_output().map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Piper failed: {}", stderr));
    }

    Ok(output_path.to_string_lossy().to_string())
}

/// Create a child webview at the given logical coordinates inside the main window.
/// Requires the "unstable" Tauri feature.
#[tauri::command]
async fn create_inline_webview(
    app: tauri::AppHandle,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let parsed_url = tauri::Url::parse(&url).map_err(|e| e.to_string())?;
    window
        .add_child(
            tauri::WebviewBuilder::new(&label, tauri::WebviewUrl::External(parsed_url)),
            tauri::LogicalPosition::new(x, y),
            tauri::LogicalSize::new(width, height),
        )
        .map_err(|e: tauri::Error| e.to_string())?;
    Ok(())
}

/// Reposition / resize an inline child webview
#[tauri::command]
async fn reposition_inline_webview(
    app: tauri::AppHandle,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        webview
            .set_position(tauri::LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        webview
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Close an inline child webview
#[tauri::command]
async fn close_inline_webview(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        webview.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Fetch og:image (or twitter:image) from a page's HTML head.
/// Streams only until </head> or 64 KB so it is fast.
#[tauri::command]
async fn fetch_og_image(url: String) -> Result<Option<String>, String> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(&url)
        .header("Accept", "text/html,application/xhtml+xml")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    // Stream only until </head> or 64 KB
    use futures_util::StreamExt;
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::with_capacity(65536);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        buf.extend_from_slice(&chunk);
        if buf.len() >= 65536 { break; }
        if let Ok(s) = std::str::from_utf8(&buf) {
            if s.to_ascii_lowercase().contains("</head>") { break; }
        }
    }

    let html = String::from_utf8_lossy(&buf);
    for prop in &["og:image", "twitter:image"] {
        if let Some(img_url) = extract_meta_content(&html, prop) {
            return Ok(Some(resolve_url(&url, &img_url)));
        }
    }
    Ok(None)
}

fn extract_meta_content(html: &str, property: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let prop_lower = property.to_ascii_lowercase();
    let mut pos = 0;
    while let Some(meta_off) = lower[pos..].find("<meta") {
        let meta_pos = pos + meta_off;
        let tag_end = lower[meta_pos..].find('>').map(|p| meta_pos + p + 1).unwrap_or(html.len());
        let tag = &html[meta_pos..tag_end];
        let tag_lower = &lower[meta_pos..tag_end];
        let has_prop = tag_lower.contains(&format!("property=\"{}\"", prop_lower))
            || tag_lower.contains(&format!("property='{}'",  prop_lower))
            || tag_lower.contains(&format!("name=\"{}\"",    prop_lower))
            || tag_lower.contains(&format!("name='{}'",      prop_lower));
        if has_prop {
            if let Some(content) = extract_attr_value(tag, "content") {
                return Some(content);
            }
        }
        pos = tag_end;
    }
    None
}

fn extract_attr_value(tag: &str, attr: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    // Try attr="..."
    let dq = format!("{}=\"", attr.to_ascii_lowercase());
    if let Some(p) = lower.find(&dq) {
        let start = p + dq.len();
        let end = tag[start..].find('"')? + start;
        return Some(tag[start..end].trim().to_string());
    }
    // Try attr='...'
    let sq = format!("{}='", attr.to_ascii_lowercase());
    if let Some(p) = lower.find(&sq) {
        let start = p + sq.len();
        let end = tag[start..].find('\'')? + start;
        return Some(tag[start..end].trim().to_string());
    }
    None
}

fn resolve_url(base: &str, img_url: &str) -> String {
    if img_url.starts_with("https://") || img_url.starts_with("http://") {
        return img_url.to_string();
    }
    if img_url.starts_with("//") {
        let proto = if base.starts_with("https") { "https:" } else { "http:" };
        return format!("{}{}", proto, img_url);
    }
    if img_url.starts_with('/') {
        let proto = if base.starts_with("https") { "https" } else { "http" };
        let after = base.strip_prefix("https://").or_else(|| base.strip_prefix("http://")).unwrap_or(base);
        let host = after.split('/').next().unwrap_or("");
        return format!("{}://{}{}", proto, host, img_url);
    }
    img_url.to_string()
}

// ── Updater ───────────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
struct UpdateInfo {
    version: String,
    current_version: String,
    body: Option<String>,
}

#[tauri::command]
async fn check_for_updates(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await.map_err(|e| e.to_string())? {
        Some(update) => Ok(Some(UpdateInfo {
            version: update.version.clone(),
            current_version: update.current_version.clone(),
            body: update.body.clone(),
        })),
        None => Ok(None),
    }
}

#[tauri::command]
async fn download_and_install_update(app: tauri::AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    if let Some(update) = updater.check().await.map_err(|e| e.to_string())? {
        let handle = app.clone();
        update
            .download_and_install(
                move |chunk_length, content_length| {
                    let _ = handle.emit(
                        "update-download-progress",
                        serde_json::json!({
                            "chunk": chunk_length,
                            "total": content_length,
                        }),
                    );
                },
                || {},
            )
            .await
            .map_err(|e| e.to_string())?;
        app.restart();
    }
    Ok(())
}

/// Open a folder in the system file manager (Finder on macOS, Explorer on Windows, etc.)
#[tauri::command]
async fn open_in_finder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(&path).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer").arg(&path).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open").arg(&path).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Copy a file's bytes — used for drag-drop from Finder where FS scope may not cover the path
#[tauri::command]
async fn copy_file_bytes(source: String) -> Result<Vec<u8>, String> {
    std::fs::read(&source).map_err(|e| format!("Failed to read {}: {}", source, e))
}

/// Check if piper binary is installed
#[tauri::command]
async fn piper_check(app: tauri::AppHandle) -> Result<bool, String> {
    let piper_path = piper_dir(&app);
    let bin = if cfg!(target_os = "windows") {
        piper_path.join("piper.exe")
    } else {
        piper_path.join("piper")
    };
    Ok(bin.exists())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_deep_link::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_shell::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      let handle = app.handle();

      let gnos = SubmenuBuilder::new(handle, "Gnos")
        .item(&tauri::menu::MenuItem::with_id(handle, "about", "About Gnos", true, None::<&str>)?)
        .build()?;

      let books = SubmenuBuilder::new(handle, "Books")
        .item(&tauri::menu::MenuItem::with_id(handle, "import", "Import Book", true, None::<&str>)?)
        .item(&tauri::menu::MenuItem::with_id(handle, "new_notebook", "New Notebook", true, None::<&str>)?)
        .item(&tauri::menu::MenuItem::with_id(handle, "new_sketchbook", "New Sketchbook", true, None::<&str>)?)
        .build()?;

      let edit = SubmenuBuilder::new(handle, "Edit")
        .item(&PredefinedMenuItem::undo(handle, None)?)
        .item(&PredefinedMenuItem::redo(handle, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(handle, None)?)
        .item(&PredefinedMenuItem::copy(handle, None)?)
        .item(&PredefinedMenuItem::paste(handle, None)?)
        .item(&PredefinedMenuItem::select_all(handle, None)?)
        .build()?;

      let actions = SubmenuBuilder::new(handle, "Actions")
        .item(&tauri::menu::MenuItem::with_id(handle, "undo", "Undo", true, None::<&str>)?)
        .item(&tauri::menu::MenuItem::with_id(handle, "redo", "Redo", true, None::<&str>)?)
        .build()?;

      let view = SubmenuBuilder::new(handle, "View")
        .item(&tauri::menu::MenuItem::with_id(handle, "tab_library", "Library", true, Some("CmdOrCtrl+1"))?)
        .item(&tauri::menu::MenuItem::with_id(handle, "tab_books", "Books", true, Some("CmdOrCtrl+2"))?)
        .item(&tauri::menu::MenuItem::with_id(handle, "tab_audiobooks", "Audiobooks", true, Some("CmdOrCtrl+3"))?)
        .item(&tauri::menu::MenuItem::with_id(handle, "tab_notebooks", "Notebooks", true, Some("CmdOrCtrl+4"))?)
        .item(&tauri::menu::MenuItem::with_id(handle, "tab_collections", "Collections", true, Some("CmdOrCtrl+5"))?)
        .build()?;

      let window_menu = SubmenuBuilder::new(handle, "Window")
        .item(&PredefinedMenuItem::minimize(handle, Some("Minimize"))?)
        .item(&PredefinedMenuItem::maximize(handle, Some("Zoom"))?)
        .item(&tauri::menu::MenuItem::with_id(handle, "fullscreen", "Enter Full Screen", true, Some("Ctrl+Command+F"))?)
        .build()?;

      let menu = MenuBuilder::new(handle)
        .items(&[&gnos, &edit, &books, &actions, &view, &window_menu])
        .build()?;

      app.set_menu(menu)?;

      let window = app.get_webview_window("main").unwrap();

      #[cfg(target_os = "macos")]
      {
        use tauri::TitleBarStyle;
        window.set_title_bar_style(TitleBarStyle::Overlay)?;
      }

      #[cfg(any(target_os = "windows", target_os = "linux"))]
      {
        window.set_decorations(true)?;
      }

      // Set icon based on current system theme, and update on theme change
      let initial_theme = window.theme().unwrap_or(tauri::Theme::Dark);
      set_app_icon(&window, initial_theme);
      let window_for_theme = window.clone();
      window.on_window_event(move |event| {
        if let tauri::WindowEvent::ThemeChanged(theme) = event {
          set_app_icon(&window_for_theme, *theme);
        }
      });

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      piper_list_voices,
      piper_speak,
      piper_check,
      copy_file_bytes,
      open_in_finder,
      create_inline_webview,
      reposition_inline_webview,
      close_inline_webview,
      fetch_og_image,
      check_for_updates,
      download_and_install_update,
    ])
    .on_menu_event(|app, event| {
      let id = event.id().as_ref();
      if id == "fullscreen" {
        if let Some(win) = app.get_webview_window("main") {
          let is_fs = win.is_fullscreen().unwrap_or(false);
          let _ = win.set_fullscreen(!is_fs);
        }
        return;
      }
      app.emit("menu", id).unwrap();
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}