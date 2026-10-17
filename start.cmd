@echo off
REM VoiceAI 启动脚本（Windows）
REM 用法：
REM   start.cmd              服务器麦克风（Python sounddevice，默认）
REM   start.cmd browser      浏览器麦克风（getUserMedia + WebRTC 回声消除）
setlocal
set NODE_EXE=D:\node-v22.21.1-win-x64\node.exe
if not exist "%NODE_EXE%" (
  echo [warn] %NODE_EXE% 不存在，退回 PATH 中的 node
  set NODE_EXE=node
)
cd /d "%~dp0"
if /i "%~1"=="browser" (
  echo [VoiceAI] 采集模式：浏览器麦克风（已开启回声消除）
  "%NODE_EXE%" server.js --capture=browser
) else (
  echo [VoiceAI] 采集模式：服务器麦克风
  "%NODE_EXE%" server.js
)
