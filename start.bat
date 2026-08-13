@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (
  echo 首次运行：正在安装 Electron 依赖（约 1-2 分钟）...
  npm install
  if errorlevel 1 ( echo 安装失败，请检查 Node.js 环境 & pause & exit /b 1 )
)
npm start
