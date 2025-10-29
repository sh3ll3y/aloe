# Repository Guidelines

## Project Structure & Module Organization
Keep the root lean: production code lives under `src/aloe/`, automated tests under `tests/`, and shared assets such as fixtures or sample data under `assets/`. Document architecture notes or ADRs in `docs/`. When introducing a new feature, create a focused module (for example `src/aloe/ingest/`) and co-locate supporting helpers in the same package so the dependency graph stays obvious. Avoid committing generated artifacts; surface them via `.gitignore` instead.

## Build, Test, and Development Commands
Standardize on `make` targets so every contributor has the same entry points:
- `make bootstrap` sets up the virtual environment and installs all dependencies.
- `make lint` runs `ruff format` and `ruff check` to enforce style and static analysis.
- `make test` invokes `pytest` with verbose output and coverage reporting.
- `make run` executes the main entry point (replace with the top-level CLI or service module once it lands).
Add any new workflow command as a Make target and document flags inline with comments.

## Coding Style & Naming Conventions
Target Python 3.11. Use 4-space indentation, type hints on public functions, and prefer dataclasses for structured data. Modules and functions use `snake_case`, classes use `PascalCase`, and constants are upper snake. Keep modules under ~400 lines; split logic rather than introducing deeply nested conditionals. Always run `ruff` (configured via `pyproject.toml` once added) before committing.

## Testing Guidelines
Write unit tests with `pytest` and place them under `tests/` mirroring the source package layout (`tests/aloe/test_ingest.py` for `src/aloe/ingest.py`). Name files `test_*.py` and keep each test focused on one behavior. Aim for ≥90% statement coverage; if you cannot reach that threshold, explain the gap in the pull request. Integration or contract tests belong under `tests/integration/` and may use fixtures from `assets/`.

## Commit & Pull Request Guidelines
Use short, imperative commit subjects (`Add ingest parser`, `Fix CLI flag parsing`). Break work into logical commits and include a concise body when context is not obvious. Pull requests should summarize the change, link any relevant issue, describe test coverage, and include screenshots or logs for user-visible changes. Request review only after `make lint` and `make test` pass locally.

## Security & Configuration Tips
Never commit secrets or API keys; provide placeholders via `.env.example` and load real values from the environment. Sanitize sample data before sharing. Review third-party dependencies during onboarding and pin versions in the dependency file to keep builds reproducible.
