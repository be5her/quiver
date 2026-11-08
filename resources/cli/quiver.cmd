@echo off
rem quiver: Quiver's command line (docs/cli.md). Runs the app's own Node on the CLI script inside app.asar.
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\Quiver.exe" "%~dp0..\app.asar\out\main\cli.js" %*
exit /b %ERRORLEVEL%
