@echo off
cd /d "%~dp0"
if not exist "%~dp0.venv\Scripts\python.exe" goto missing
"%~dp0.venv\Scripts\python.exe" "%~dp0launch_monitor.py" %*
pause
exit /b
:missing
echo Run setup_windows_nvidia.cmd or setup_windows_cpu.cmd first.
pause
