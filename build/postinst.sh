#!/bin/bash
# WSLg ignores the Icon field in .desktop files, causing the Windows taskbar
# to show a generic Linux penguin instead of the app's _NET_WM_ICON.
# Removing the .desktop file lets WSLg use the BrowserWindow icon correctly.
rm -f /usr/share/applications/dad.desktop

# Ensure the 'dad' command is available on PATH
ln -sf "/opt/Developer Automation Desktop/dad" /usr/bin/dad
