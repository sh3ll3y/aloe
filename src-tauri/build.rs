use std::path::Path;

fn main() {
  // Perform Tauri codegen/build first.
  tauri_build::build();

  // Build-time guardrails: verify that bundled OCR assets exist so releases
  // include everything needed to run on a clean machine.
  // These paths are relative to `src-tauri/`.

  let tessdata_eng = Path::new("resources").join("tessdata").join("eng.traineddata");
  if !tessdata_eng.exists() {
    // Fail the build to prevent shipping an app without OCR language data.
    println!(
      "cargo:warning=Missing OCR traineddata at src-tauri/resources/tessdata/eng.traineddata"
    );
    panic!(
      "OCR language data not found. Ensure src-tauri/resources/tessdata/eng.traineddata is present."
    );
  }

  // Ensure TSV config exists so TSV output works without relying on system configs.
  let tsv_cfg = Path::new("resources").join("tessdata").join("configs").join("tsv");
  if !tsv_cfg.exists() {
    println!(
      "cargo:warning=Missing TSV config at src-tauri/resources/tessdata/configs/tsv; TSV output may fail"
    );
  }

  // Check that the bundled tesseract binary for macOS arm64 exists.
  // You may add similar checks for other targets (e.g., macOS x64) if you ship them.
  let tesseract_arm64 = Path::new("bin").join("macos-arm64").join("tesseract");
  if !tesseract_arm64.exists() {
    println!(
      "cargo:warning=Bundled tesseract not found at src-tauri/bin/macos-arm64/tesseract. OCR will fail on machines without system tesseract."
    );
  }
}
