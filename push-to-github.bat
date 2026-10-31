@echo off
setlocal
set GIT_CMD="C:\Users\nasra\AppData\Local\Programs\MinGit\cmd\git.exe"

echo ========================================================
echo   Pushing App to https://github.com/dynabytedigital/tds-store-credit-app
echo ========================================================
echo.

%GIT_CMD% remote remove origin 2>nul
%GIT_CMD% remote add origin https://github.com/dynabytedigital/tds-store-credit-app.git
%GIT_CMD% branch -M main

echo Executing git push...
%GIT_CMD% push -u origin main

if %ERRORLEVEL% EQU 0 (
  echo.
  echo ========================================================
  echo   SUCCESS! Your code is now live on GitHub.
  echo   Next Step: Go to https://dashboard.render.com
  echo ========================================================
) else (
  echo.
  echo ========================================================
  echo   Push failed or pending authentication.
  echo   1. Ensure you created the repo 'tds-store-credit-app' at https://github.com/new
  echo   2. Sign in to dynabytedigital if GitHub browser popup appeared
  echo ========================================================
)

echo.
pause
