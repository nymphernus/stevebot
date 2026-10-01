@echo off
chcp 65001 >nul
title Minecraft Bot (debug)
cd /d "%~dp0"

if not exist node_modules (
    echo [1/2] Установка зависимостей...
    call npm install
    if errorlevel 1 ( echo Ошибка npm install & pause & exit /b 1 )
)

echo [2/2] Запуск с логом в stdout...
echo.
set WEB_PORT_OVERRIDE=
node bot.js 2>&1 | more
pause