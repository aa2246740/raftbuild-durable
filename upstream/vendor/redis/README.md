# Vendored redis-server (x86_64 Linux, glibc)

`bin/redis-server` + `bin/redis-cli` (6.0.16, Ubuntu jammy `redis-server`/`redis-tools`
debs) plus the shared libraries they need (`lib/`: liblzf, lua5.1, jemalloc).
Not on PATH — extracted with `apt-get download` + `dpkg -x`, no root required.

Used by `raftd stack` to satisfy the server's ioredis dependency without Docker.
Run it with:

```sh
LD_LIBRARY_PATH=<this dir>/lib <this dir>/bin/redis-server --port <p> --dir <dir> --save '' --appendonly no
```

Only pub/sub + a handful of commands (`get/set/incr/expire/hgetall/pipeline/eval/call`)
are exercised — the embedded stack treats redis as transient (no persistence flags).

Refresh: re-download the debs and repeat `dpkg -x`.
