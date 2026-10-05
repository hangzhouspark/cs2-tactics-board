@echo off
chcp 65001 >nul
title CS2 战术板 · 本地服务
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [错误] 没有找到 Node.js。
  echo.
  echo   本项目需要一个极简的本地静态服务来支持“导出 PNG”。
  echo   请先安装 Node.js（https://nodejs.org），或直接双击 index.html
  echo   使用（功能基本可用，但导出 PNG 会被浏览器安全策略拦截）。
  echo.
  pause
  exit /b 1
)

echo.
echo   正在启动本地服务 ...
node "%~dp0serve.js"

echo.
echo   服务已停止。
pause
