@echo off
cd /d "%~dp0"
where py >nul 2>nul
if errorlevel 1 (python setup_environment.py --backend cpu) else (py -3 setup_environment.py --backend cpu)
if errorlevel 1 goto failed
call start_monitor.cmd
exit /b
:failed
echo Setup failed. See the error above. Install Python 3.12 first.
pause
exit /b 1
