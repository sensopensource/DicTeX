@echo off
set NODE_OPTIONS=--use-system-ca
set PATH=%ProgramFiles%\nodejs;%PATH%
set NPM_CMD=%ProgramFiles%\nodejs\npm.cmd
if exist "%NPM_CMD%" (
  call "%NPM_CMD%" %*
) else (
  call npm.cmd %*
)
