#!/bin/sh
# Fix /data ownership when a host directory is mounted over it
chown -R codexa:codexa /data
exec su-exec codexa node server/index.js
