@echo off
chcp 65001 >nul
title Minecraft Bot
cd /d "%~dp0"

if not exist node_modules (
    echo [1/2] Установка зависимостей...
    call npm install
    if errorlevel 1 ( echo Ошибка npm install & pause & exit /b 1 )
)

echo [2/2] Запуск бота...
echo.
node bot.js
pause