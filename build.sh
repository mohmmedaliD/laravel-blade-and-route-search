#!/bin/bash

# أعد الضغط
# rm -f laravel-blade-to-view-search.vsix
zip -r laravel-blade-to-view-search.vsix extension

# ثبت
code --install-extension laravel-blade-to-view-search.vsix --force
