@echo off
cd /d "%~dp0"
where py >nul 2>nul
if errorlevel 1 (python setup_environment.py --backend nvidia) else (py -3 setup_environment.py --backend nvidia)
if errorlevel 1 goto failed
call start_monitor.cmd
exit /b
:failed
echo Setup failed. See the error above. Python 3.12 and an NVIDIA driver are required.
pause
exit /b 1
