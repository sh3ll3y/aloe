#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use std::path::PathBuf;
use std::process::Command;
use tempfile::tempdir;

#[tauri::command]
fn run_ocr(
  app_handle: tauri::AppHandle,
  image_base64: String,
  language: Option<String>,
) -> Result<String, String> {
  // Decode input
  let bytes = BASE64_STANDARD
    .decode(image_base64)
    .map_err(|err| format!("Failed to decode image data: {err}"))?;

  // Prepare temp work dir/files
  let temp_dir = tempdir().map_err(|err| format!("Failed to create temp dir: {err}"))?;
  let image_path = temp_dir.path().join("input.png");
  std::fs::write(&image_path, &bytes)
    .map_err(|err| format!("Failed to write image file: {err}"))?;
  let output_prefix = temp_dir.path().join("output");

  // Resolve bundled tesseract: Contents/MacOS/tesseract
  let exe_dir = std::env::current_exe()
    .map_err(|e| format!("Failed to get current exe path: {e}"))?
    .parent()
    .ok_or_else(|| "Failed to get exe dir".to_string())?
    .to_path_buf();
  let mut tesseract_path = exe_dir.join("tesseract");
  if !tesseract_path.exists() {
    // Fallbacks for dev: allow using system/homebrew tesseract if not bundled yet
    let candidates = [
      std::env::var_os("TESSERACT_PATH").map(PathBuf::from),
      Some(PathBuf::from("/opt/homebrew/bin/tesseract")),
      Some(PathBuf::from("/usr/local/bin/tesseract")),
      Some(PathBuf::from("/usr/bin/tesseract")),
    ];
    let mut found = None;
    for c in candidates.into_iter().flatten() {
      if c.exists() { found = Some(c); break; }
    }
    if let Some(p) = found { tesseract_path = p; } else {
      return Err("Bundled tesseract not found and no system tesseract available".to_string());
    }
  }

  // Determine TESSDATA_PREFIX robustly (directory that directly contains *.traineddata)
  let lang = language.unwrap_or_else(|| "eng".to_string());
  let mut tess_candidates: Vec<PathBuf> = Vec::new();
  if let Some(envp) = std::env::var_os("TESSDATA_PREFIX").map(PathBuf::from) {
    tess_candidates.push(envp.clone());
    tess_candidates.push(envp.join("tessdata"));
  }
  if let Some(res_dir) = app_handle.path_resolver().resource_dir() {
    tess_candidates.push(res_dir.join("tessdata"));
    // Some bundlers nest the source folder name under Resources (Resources/resources/tessdata)
    tess_candidates.push(res_dir.join("resources").join("tessdata"));
  }
  // Also consider Resources relative to the executable (…/Contents/Resources/tessdata)
  if let Some(parent_contents) = exe_dir.parent() {
    let res_root = parent_contents.join("Resources");
    tess_candidates.push(res_root.join("tessdata"));
    tess_candidates.push(res_root.join("resources").join("tessdata"));
  }
  tess_candidates.push(PathBuf::from("/opt/homebrew/share/tessdata"));
  tess_candidates.push(PathBuf::from("/usr/local/share/tessdata"));
  tess_candidates.push(PathBuf::from("/usr/share/tesseract-ocr/5/tessdata"));
  tess_candidates.push(PathBuf::from("/usr/share/tesseract-ocr/4.00/tessdata"));
  tess_candidates.push(PathBuf::from("/usr/share/tessdata"));

  let mut tess_prefix: Option<PathBuf> = None;
  for dir in tess_candidates {
    let trained = dir.join(format!("{}.traineddata", lang));
    if trained.exists() { tess_prefix = Some(dir); break; }
  }
  let tess_prefix = tess_prefix.unwrap_or_else(|| PathBuf::from("/opt/homebrew/share/tessdata"));

  // Debug info for dev: print resolved paths
  eprintln!(
    "[run_ocr_tsv] tesseract={} TESSDATA_PREFIX={} lang={}",
    tesseract_path.display(),
    tess_prefix.display(),
    lang
  );

  // Debug info for dev: print resolved paths
  eprintln!(
    "[run_ocr] tesseract={} TESSDATA_PREFIX={} lang={}",
    tesseract_path.display(),
    tess_prefix.display(),
    lang
  );

  // Run tesseract with env + args
  let output = Command::new(&tesseract_path)
    .env("TESSDATA_PREFIX", &tess_prefix)
    .arg(&image_path)
    .arg(&output_prefix)
    .arg("-l")
    .arg(&lang)
    .arg("--dpi")
    .arg("300")
    .arg("txt")
    .output()
    .map_err(|err| format!("Failed to launch tesseract: {err}"))?;

  if !output.status.success() {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    eprintln!("[run_ocr] tesseract stderr: {}", stderr);
    return Err(format!("Tesseract failed: {stderr}"));
  }

  // Read recognized text
  let mut text_path = PathBuf::from(&output_prefix);
  text_path.set_extension("txt");
  let text = std::fs::read_to_string(&text_path)
    .map_err(|err| format!("Failed to read OCR output: {err}"))?;

  // Clean up artifacts (best-effort)
  let _ = std::fs::remove_file(&text_path);
  Ok(text)
}

#[tauri::command]
fn run_ocr_tsv(
  app_handle: tauri::AppHandle,
  image_base64: String,
  language: Option<String>,
) -> Result<String, String> {
  let bytes = BASE64_STANDARD
    .decode(image_base64)
    .map_err(|err| format!("Failed to decode image data: {err}"))?;

  let temp_dir = tempdir().map_err(|err| format!("Failed to create temp dir: {err}"))?;
  let image_path = temp_dir.path().join("input.png");
  std::fs::write(&image_path, &bytes)
    .map_err(|err| format!("Failed to write image file: {err}"))?;
  let output_prefix = temp_dir.path().join("output");

  let exe_dir = std::env::current_exe()
    .map_err(|e| format!("Failed to get current exe path: {e}"))?
    .parent()
    .ok_or_else(|| "Failed to get exe dir".to_string())?
    .to_path_buf();
  let mut tesseract_path = exe_dir.join("tesseract");
  if !tesseract_path.exists() {
    let candidates = [
      std::env::var_os("TESSERACT_PATH").map(PathBuf::from),
      Some(PathBuf::from("/opt/homebrew/bin/tesseract")),
      Some(PathBuf::from("/usr/local/bin/tesseract")),
      Some(PathBuf::from("/usr/bin/tesseract")),
    ];
    let mut found = None;
    for c in candidates.into_iter().flatten() { if c.exists() { found = Some(c); break; } }
    if let Some(p) = found { tesseract_path = p; } else {
      return Err("Bundled tesseract not found and no system tesseract available".to_string());
    }
  }

  // Determine TESSDATA_PREFIX robustly (directory that directly contains *.traineddata)
  let lang = language.unwrap_or_else(|| "eng".to_string());
  let mut tess_candidates: Vec<PathBuf> = Vec::new();
  if let Some(envp) = std::env::var_os("TESSDATA_PREFIX").map(PathBuf::from) {
    tess_candidates.push(envp.clone());
    tess_candidates.push(envp.join("tessdata"));
  }
  if let Some(res_dir) = app_handle.path_resolver().resource_dir() {
    tess_candidates.push(res_dir.join("tessdata"));
    tess_candidates.push(res_dir.join("resources").join("tessdata"));
  }
  if let Some(parent_contents) = exe_dir.parent() {
    let res_root = parent_contents.join("Resources");
    tess_candidates.push(res_root.join("tessdata"));
    tess_candidates.push(res_root.join("resources").join("tessdata"));
  }
  tess_candidates.push(PathBuf::from("/opt/homebrew/share/tessdata"));
  tess_candidates.push(PathBuf::from("/usr/local/share/tessdata"));
  tess_candidates.push(PathBuf::from("/usr/share/tesseract-ocr/5/tessdata"));
  tess_candidates.push(PathBuf::from("/usr/share/tesseract-ocr/4.00/tessdata"));
  tess_candidates.push(PathBuf::from("/usr/share/tessdata"));

  let mut tess_prefix: Option<PathBuf> = None;
  for dir in tess_candidates {
    let trained = dir.join(format!("{}.traineddata", lang));
    if trained.exists() { tess_prefix = Some(dir); break; }
  }
  let tess_prefix = tess_prefix.unwrap_or_else(|| PathBuf::from("/opt/homebrew/share/tessdata"));
  let output = Command::new(&tesseract_path)
    .env("TESSDATA_PREFIX", &tess_prefix)
    .arg(&image_path)
    .arg(&output_prefix)
    .arg("-l")
    .arg(&lang)
    .arg("--dpi")
    .arg("300")
    .arg("tsv")
    .output()
    .map_err(|err| format!("Failed to launch tesseract: {err}"))?;

  if !output.status.success() {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    return Err(format!("Tesseract TSV failed: {stderr}"));
  }

  let mut tsv_path = PathBuf::from(&output_prefix);
  tsv_path.set_extension("tsv");
  let tsv = std::fs::read_to_string(&tsv_path)
    .map_err(|err| format!("Failed to read OCR TSV output: {err}"))?;
  let _ = std::fs::remove_file(&tsv_path);
  Ok(tsv)
}

fn main() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![run_ocr, run_ocr_tsv])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
