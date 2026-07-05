#!/usr/bin/env sh
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--use-system-ca"
exec npm "$@"

