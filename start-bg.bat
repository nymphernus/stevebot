@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist node_modules (
    echo [1/2] Установка зависимостей...
    call npm install
    if errorlevel 1 ( echo Ошибка npm install & pause & exit /b 1 )
)

set LOGFILE=bot_%DATE:~-4%%DATE:~3,2%%DATE:~0,2%_%TIME:~0,2%%TIME:~3,2%.log
set LOGFILE=%LOGFILE: =0%

echo [2/2] Запуск в фоне, лог: %LOGFILE%
start "" /B node bot.js > "%LOGFILE%" 2>&1
echo PID записан в bot.pid
for /f "tokens=2" %%i in ('tasklist /FI "IMAGENAME eq node.exe" /NH') do echo %%i > bot.pid
echo Для остановки: taskkill /IM node.exe /F
echo Логи бота также пишутся в logs\bot-ГГГГ-ММ-ДД.log
pause