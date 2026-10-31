@echo off
title The Dental Shaman - 10 GBP Store Credit Dispatcher
cd /d "%~dp0"
echo =======================================================
echo   The Dental Shaman - 10 GBP Store Credit Dispatcher
echo   Connected to: shop.thedentalshaman.com
echo   Sender: shop@thedentalshaman.com (Hostinger SMTP)
echo =======================================================
echo Starting server on http://localhost:3050 ...
start http://localhost:3050
node server.js
pause
