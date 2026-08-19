@echo off
REM Publish the Splat.js app to https://nightly.arrival.space/splatjs/index.html
node "%~dp0deploy_nightly.mjs" %*
