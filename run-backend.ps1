# Este script roda o backend usando a .venv automaticamente
.\.venv\Scripts\python.exe -m uvicorn backend.main:app --reload --port 8000
