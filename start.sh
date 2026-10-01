#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "[1/2] Установка зависимостей..."
  npm install
fi

echo "[2/2] Запуск бота..."
exec node bot.js